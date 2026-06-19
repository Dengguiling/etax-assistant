// content.js —— 接收 FILL 消息并执行填充
// 注入到 *.guangdong.chinatax.gov.cn/* 的所有 frame（manifest 配了 all_frames:true）。
//
// 关键点：登录页是 Vue + ElementUI SPA，普通 el.value = x 不会触发响应式，
// 必须用原生 setter 并 dispatch input/change 事件。

(function () {
  'use strict';

  if (window.__ETAX_CONTENT_LOADED__) return; // 防止重复注入
  window.__ETAX_CONTENT_LOADED__ = true;

  // Vue 响应式友好赋值
  function setNativeValue(el, value) {
    const proto = window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    // ElementUI 常用 blur 触发校验
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  function focusAndMaybeClick(el) {
    try { el.focus(); } catch (e) {}
  }

  // 在"当前 frame"内执行填充。selectors 为用户自定义覆盖（可空）。
  // 字段定位优先级：用户自定义 selector → 税局新版精确选择器（已验证）→ 智能关键词匹配。
  // 返回 { filled:[], missed:[], diagnostics:[] }
  function fillHere(account, selectors) {
    const sel = selectors || {};
    const precise = window.EtaxMatcher.matchByPrecise();
    const smart = window.EtaxMatcher.matchFields();

    // 逐字段按优先级取第一个命中的元素
    function pick(field, customSel) {
      if (customSel) {
        const el = window.EtaxMatcher.findBySelector(customSel);
        if (el) return el;
      }
      if (precise[field]) return precise[field];
      return smart[field];
    }

    const targets = {
      creditCode: pick('creditCode', sel.creditCode),
      username:   pick('username',   sel.username),
      password:   pick('password',   sel.password),
    };

    const filled = [], missed = [];
    const values = {
      creditCode: account.creditCode,
      username: account.username,
      password: account.password,
    };
    const labels = { creditCode: '信用代码', username: '用户名', password: '密码' };

    for (const f of ['creditCode', 'username', 'password']) {
      const el = targets[f];
      if (el && values[f] != null && values[f] !== '') {
        try {
          setNativeValue(el, values[f]);
          filled.push(labels[f]);
        } catch (e) {
          missed.push(labels[f]);
        }
      } else {
        // 只有当该字段有值却找不到框时才算 missed
        if (values[f] != null && values[f] !== '') missed.push(labels[f]);
      }
    }

    // 填完后聚焦密码框，方便用户直接确认
    if (targets.password) focusAndMaybeClick(targets.password);

    return { filled, missed, diagnostics: smart.diagnostics };
  }

  // 判断当前 frame 是否包含登录相关 input
  function looksLikeLoginForm() {
    const inputs = Array.from(document.querySelectorAll('input'));
    if (!inputs.length) return false;
    const hasPwd = inputs.some((i) => i.type === 'password');
    const hasText = inputs.some((i) => i.type === 'text' || i.type === '' || !i.type);
    return hasPwd || hasText;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'PING') { sendResponse({ ok: true, frameId: sender.frameId }); return false; }
    if (msg.type !== 'FILL') return;

    (async () => {
      try {
        // 当前 frame 试着填
        const here = fillHere(msg.account, msg.selectors);

        // 如果当前 frame 填到了至少一个字段，认为命中登录表单
        if (here.filled.length > 0) {
          // 成功；但若仍有缺失字段，也回传诊断供查看
          sendResponse({
            ok: here.missed.length === 0,
            filled: here.filled,
            missed: here.missed,
            diagnostics: here.diagnostics,
          });
          return;
        }

        // 当前 frame 没填到：可能是登录表单在子 iframe 里。
        // 通过 chrome.tabs.sendMessage 发给同 tab 的所有 frame。
        // 注意：content script 无法直接访问跨域子 frame 的 DOM，
        // 这里改为「让 background 把消息广播到所有 frame」——但当前架构是 sidepanel 直接发给 tab，
        // 所以本 frame 若不是表单所在 frame，就交由其它 frame 的同款监听器处理（all_frames 已注入）。
        // 为避免无响应，当前 frame 也回一个「未命中」结果，让 sidepanel 能据此判断。
        sendResponse({
          ok: false,
          filled: [],
          missed: ['信用代码', '用户名', '密码'],
          diagnostics: here.diagnostics,
          notInThisFrame: looksLikeLoginForm() === false,
        });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e), filled: [], missed: [] });
      }
    })();
    return true; // 异步
  });
})();
