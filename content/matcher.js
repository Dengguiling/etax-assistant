// matcher.js —— 智能字段匹配
// 在 content script 作用域内执行（通过 manifest content_scripts 注入，或 sidepanel 主动 executeScript 注入）。
// 暴露 window.EtaxMatcher。
//
// 税局登录页基于 Vue + ElementUI，结构形如：
//   <div class="el-form-item">
//     <label class="el-form-item__label">统一社会信用代码</label>
//     <div class="el-form-item__content">
//       <div class="el-input"><input class="el-input__inner" placeholder="..." /></div>
//     </div>
//   </div>
// 本模块对每个可见 input 综合打分，把"信用代码 / 用户名 / 密码"匹配到最高分 input。

(function (global) {
  'use strict';

  const FIELD_KEYWORDS = {
    creditCode: ['信用代码', '统一社会信用', '社会信用', '纳税人识别', '税号', '统一信用', '信用', 'credit', 'uscc', 'shxydm', 'taxno', 'tin', 'nsrsbh'],
    username:   ['实名账号', '用户名', '登录账号', '登录名', '账号', '账户', '实名', '用户', '手机号', '手机', '身份证', '证件号', '证件', 'username', 'account', 'login', 'mobile', 'userid', 'user', 'phone'],
    password:   ['密码', '口令', 'password', 'pwd', 'pass'],
  };

  // 广东电子税局新版登录页（tpass.guangdong.chinatax.gov.cn）验证有效的精确选择器。
  // 来源：旧版 tampermonkey 脚本（gd-tax-plugin v1.1.0）中已实际跑通的路径。
  // 结构：#app > .loginCls > .mainCls > ... > .login_box > .password_ddd > .formContentE
  //       > div > div:nth-child(1) > div:nth-child(1) > div > form > div:nth-child(N) ...
  // 三个字段即 form 下第 1/2/3 个 .el-form-item。
  const PRECISE_SELECTORS = {
    creditCode: '#app .loginCls .login_box .formContentE form > div.el-form-item:nth-child(1) input',
    username:   '#app .loginCls .login_box .formContentE form > div.el-form-item:nth-child(2) input',
    password:   '#app .loginCls .login_box .formContentE form > div.el-form-item:nth-child(3) input',
    // 更宽松的兜底（万一外层 class 名微调）：form 下三个 form-item 的 input
    creditCodeLoose: '#app .loginCls form .el-form-item:nth-child(1) input',
    usernameLoose:   '#app .loginCls form .el-form-item:nth-child(2) input',
    passwordLoose:   '#app .loginCls form .el-form-item:nth-child(3) input',
  };

  // 跳过明显不是登录字段的 input
  const SKIP_KEYWORDS = ['验证码', 'captcha', '短信', '图形', 'remember', '记住'];

  function isVisible(el) {
    if (!el || el.disabled) return false;
    if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button' || el.type === 'image' || el.type === 'reset') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = global.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (parseFloat(style.opacity) === 0) return false;
    return true;
  }

  // 从 input 往上找关联的 label 文本
  function nearbyLabel(el) {
    // 1) <label for=id>
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab) return lab.textContent || '';
    }
    // 2) aria-label / aria-labelledby
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    if (el.getAttribute('aria-labelledby')) {
      const t = document.getElementById(el.getAttribute('aria-labelledby'));
      if (t) return t.textContent || '';
    }
    // 3) 父级链中找 .el-form-item__label / .el-form-item / label
    let node = el.parentElement;
    for (let i = 0; i < 6 && node; i++, node = node.parentElement) {
      const lab = node.querySelector(':scope > .el-form-item__label, :scope > .el-form-item__content > .el-form-item__label');
      if (lab && lab.textContent && lab.textContent.trim()) return lab.textContent.trim();
      // 直接是 label 标签
      if (node.tagName === 'LABEL') return node.textContent || '';
      // 收集非 input 文本（常见于自定义结构）
      const txt = Array.from(node.childNodes)
        .filter((n) => n.nodeType === 3 && n.textContent && n.textContent.trim())
        .map((n) => n.textContent.trim())
        .join(' ');
      if (txt && txt.length <= 20) return txt;
    }
    return '';
  }

  // 给一个 input 对某字段的打分
  function scoreFor(el, field) {
    const text = [
      el.placeholder || '',
      el.getAttribute('aria-label') || '',
      el.id || '',
      el.name || '',
      el.getAttribute('data-field') || '',
      nearbyLabel(el),
    ].join(' ').toLowerCase().replace(/\s+/g, '');

    let score = 0;
    for (const kw of FIELD_KEYWORDS[field]) {
      if (text.includes(kw.toLowerCase())) {
        score = Math.max(score, kw.length + 1); // 关键词越长权重越高
      }
    }
    // password 类型 input：直接给 password 字段加权
    if (field === 'password' && el.type === 'password') score = Math.max(score, 5);
    // 密码字段不应出现在非 password 类型的明显文字字段
    if (field !== 'password' && el.type === 'password') score = Math.min(score, 0);

    // 跳过验证码等字段
    for (const sk of SKIP_KEYWORDS) {
      if (text.includes(sk)) { score = 0; break; }
    }
    return score;
  }

  // 主匹配：返回 { creditCode: el|null, username: el|null, password: el|null, diagnostics: [] }
  function matchFields() {
    const inputs = Array.from(document.querySelectorAll('input'));
    const visible = inputs.filter(isVisible);

    const result = { creditCode: null, username: null, password: null, diagnostics: [] };
    const best = { creditCode: { score: 0, el: null }, username: { score: 0, el: null }, password: { score: 0, el: null } };

    for (const el of visible) {
      for (const field of ['creditCode', 'username', 'password']) {
        const s = scoreFor(el, field);
        if (s > best[field].score) {
          best[field] = { score: s, el };
        }
      }
    }

    // 阈值：分数 < 2 视为没匹配上
    const THRESHOLD = 2;
    for (const field of ['creditCode', 'username', 'password']) {
      if (best[field].score >= THRESHOLD && best[field].el) {
        result[field] = best[field].el;
      }
    }

    // 去重：避免同一个 input 被两个字段同时占用（按最高分归属）
    const assigned = new Set();
    const fields = ['creditCode', 'username', 'password'];
    fields.sort((a, b) => best[b].score - best[a].score);
    for (const f of fields) {
      if (result[f] && assigned.has(result[f])) {
        result[f] = null; // 被更高分的字段占用了
      } else if (result[f]) {
        assigned.add(result[f]);
      }
    }

    // 诊断信息：所有可见 input 的关键属性，供用户填写 selector 参考
    result.diagnostics = visible.map((el) => ({
      type: el.type,
      placeholder: el.placeholder || '',
      id: el.id || '',
      name: el.name || '',
      aria: el.getAttribute('aria-label') || '',
      label: nearbyLabel(el),
    }));

    return result;
  }

  // 通过自定义 selector 查找（取第一个可见的）
  function findBySelector(sel) {
    if (!sel) return null;
    try {
      const list = Array.from(document.querySelectorAll(sel));
      return list.find(isVisible) || null;
    } catch (e) {
      return null; // 非法 selector
    }
  }

  // 用税局新版登录页验证有效的精确选择器查找。
  // 优先精确路径，失败再用宽松兜底。返回 { creditCode, username, password }（均可能为 null）。
  function matchByPrecise() {
    const pick = (sel) => {
      const el = findBySelector(sel);
      return el && isVisible(el) ? el : null;
    };
    return {
      creditCode: pick(PRECISE_SELECTORS.creditCode) || pick(PRECISE_SELECTORS.creditCodeLoose),
      username:   pick(PRECISE_SELECTORS.username)   || pick(PRECISE_SELECTORS.usernameLoose),
      password:   pick(PRECISE_SELECTORS.password)   || pick(PRECISE_SELECTORS.passwordLoose),
    };
  }

  global.EtaxMatcher = {
    matchFields, findBySelector, matchByPrecise, FIELD_KEYWORDS, PRECISE_SELECTORS,
  };
})(typeof window !== 'undefined' ? window : self);
