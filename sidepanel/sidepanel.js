// sidepanel.js —— 侧边栏主逻辑
// 功能：导入 Excel（智能列映射）/ 搜索 / 回车或点击填充 / 设置 selector / 诊断展示

'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const els = {
  fileInput: $('#file-input'),
  importHint: $('#import-hint'),
  importResult: $('#import-result'),
  mapper: $('#mapper'),
  search: $('#search'),
  count: $('#count'),
  btnClear: $('#btn-clear'),
  list: $('#list'),
  toast: $('#toast'),
  diag: $('#diag'),
  diagBody: $('#diag-body'),
  btnSettings: $('#btn-settings'),
  settingsPanel: $('#settings-panel'),
  selCredit: $('#sel-creditCode'),
  selUser: $('#sel-username'),
  selPwd: $('#sel-password'),
};

let allResults = [];     // 当前搜索结果（脱敏）
let activeIndex = -1;    // 键盘选中项
let pendingSheet = null; // 待确认映射的工作表数据 { headers, rows }

// ---------- 消息封装 ----------
function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}
function toast(msg, type = '') {
  els.toast.textContent = msg;
  els.toast.className = 'toast ' + type;
  setTimeout(() => els.toast.classList.add('hidden'), 2200);
}

// ---------- 列头智能映射 ----------
// 识别中英文关键词，把 Excel 列名映射到字段
const COLUMN_KEYWORDS = {
  company:    ['公司名称', '公司', '企业', '单位', '名称', '客户', '主体', 'company', 'name', 'firm'],
  creditCode: ['统一信用代码', '统一社会信用', '信用代码', '社会信用', '税号', '纳税人识别', '信用', 'credit', 'uscc', 'taxno', 'shxydm', 'tin'],
  username:   ['实名账号', '登录账号', '用户名', '登录名', '账号', '账户', '实名', '用户', '手机', '身份证', '证件号', 'username', 'account', 'login', 'mobile', 'userid', 'user'],
  password:   ['密码', '口令', 'password', 'pwd', 'pass'],
};
function guessField(header) {
  const h = String(header || '').trim().toLowerCase();
  if (!h) return null;
  let best = null, bestScore = 0;
  for (const [field, kws] of Object.entries(COLUMN_KEYWORDS)) {
    for (const kw of kws) {
      if (h.includes(kw)) {
        // 长关键词权重高
        const score = kw.length;
        if (score > bestScore) { bestScore = score; best = field; }
      }
    }
  }
  return best;
}

// ---------- 导入 ----------
els.fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  els.importResult.textContent = '正在解析…';
  els.importResult.classList.remove('err');
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const firstSheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(firstSheet, { header: 1, defval: '' }); // 二维数组
    if (!rows.length) throw new Error('文件为空');

    // 第一行当表头
    const headers = rows[0].map((h, i) => String(h || '').trim() || `第${i + 1}列`);
    const dataRows = rows.slice(1).filter((r) => r.some((c) => String(c).trim() !== ''));
    if (!dataRows.length) throw new Error('没有数据行');

    pendingSheet = { headers, rows: dataRows };
    // 自动猜测映射
    const guess = { company: '', creditCode: '', username: '', password: '' };
    const used = new Set();
    for (let i = 0; i < headers.length; i++) {
      const f = guessField(headers[i]);
      if (f && !guess[f] && !used.has(f)) { guess[f] = headers[i]; used.add(f); }
    }
    // 兜底：如果某字段没识别到，按前 4 列顺序补
    const fields = ['company', 'creditCode', 'username', 'password'];
    let colIdx = 0;
    for (const f of fields) {
      if (!guess[f]) {
        while (colIdx < headers.length && used.has(headers[colIdx])) colIdx++;
        if (colIdx < headers.length) { guess[f] = headers[colIdx]; used.add(headers[colIdx]); colIdx++; }
      }
    }

    // 渲染下拉
    for (const f of fields) {
      const sel = els.mapper.querySelector(`select[data-field="${f}"]`);
      sel.innerHTML = headers.map((h) => `<option value="${escapeAttr(h)}" ${h === guess[f] ? 'selected' : ''}>${escapeHtml(h)}</option>`).join('');
    }
    els.mapper.classList.remove('hidden');
    els.importResult.textContent = `已解析 ${dataRows.length} 行，请确认列对应关系后点「确认导入」`;
  } catch (err) {
    els.importResult.textContent = '解析失败：' + (err.message || err);
    els.importResult.classList.add('err');
  } finally {
    els.fileInput.value = ''; // 允许重复选同一文件
  }
});

$('#mapper-confirm').addEventListener('click', async () => {
  if (!pendingSheet) return;
  const fieldToHeader = {};
  for (const sel of els.mapper.querySelectorAll('select')) {
    fieldToHeader[sel.dataset.field] = sel.value;
  }
  const { headers, rows } = pendingSheet;
  const colIndex = (header) => headers.indexOf(header);
  // 统一社会信用代码格式：18 位字母数字（参考旧脚本校验规则）
  const CREDIT_RE = /^[A-Za-z0-9]{18}$/;
  const out = rows.map((r) => ({
    company:    String(r[colIndex(fieldToHeader.company)] || '').trim(),
    creditCode: String(r[colIndex(fieldToHeader.creditCode)] || '').trim(),
    username:   String(r[colIndex(fieldToHeader.username)] || '').trim(),
    password:   String(r[colIndex(fieldToHeader.password)] || ''),
  })).filter((x) => x.company || x.creditCode || x.username);

  // 校验信用代码格式，统计不规范行
  const invalid = out.filter((x) => x.creditCode && !CREDIT_RE.test(x.creditCode));
  if (invalid.length) {
    if (!confirm(`检测到 ${invalid.length} 条信用代码不是标准 18 位字母数字格式，仍要导入吗？（这些记录会照常保存，但可能影响登录匹配）`)) {
      return;
    }
  }

  const res = await send({ type: 'IMPORT_ACCOUNTS', rows: out });
  if (res && res.ok) {
    els.importResult.textContent = `✓ 导入成功：新增 ${res.added} 条，更新 ${res.updated} 条，共 ${res.total} 条`
      + (invalid.length ? `（其中 ${invalid.length} 条信用代码格式不规范）` : '');
    els.mapper.classList.add('hidden');
    pendingSheet = null;
    await refreshList();
  } else {
    els.importResult.textContent = '导入失败：' + (res && res.error);
    els.importResult.classList.add('err');
  }
});
$('#mapper-cancel').addEventListener('click', () => {
  els.mapper.classList.add('hidden');
  pendingSheet = null;
  els.importResult.textContent = '';
});

// ---------- 搜索 ----------
async function refreshList() {
  const q = els.search.value.trim();
  const res = q ? await send({ type: 'SEARCH', query: q }) : await send({ type: 'LIST_ALL' });
  allResults = (res && res.results) || [];
  activeIndex = allResults.length ? 0 : -1;
  renderList();
  els.count.textContent = `共 ${allResults.length} 家`;
  const totalRes = await send({ type: 'LIST_ALL' });
  const total = (totalRes && totalRes.accounts && totalRes.accounts.length) || 0;
  els.btnClear.classList.toggle('hidden', total === 0);
}

function renderList() {
  if (!allResults.length) {
    els.list.innerHTML = `<li class="empty">${els.search.value.trim() ? '没有匹配的公司' : '尚未导入账号，请先点击上方导入 Excel'}</li>`;
    return;
  }
  els.list.innerHTML = allResults.map((a, i) => {
    const tail = a.creditCode ? a.creditCode.slice(-6) : '—';
    return `<li data-id="${escapeAttr(a.id)}" class="${i === activeIndex ? 'active' : ''}">
      <span class="li-company">${escapeHtml(a.company || '(未命名)')}</span>
      <span class="li-sub">信用代码尾号 ${tail} · ${escapeHtml(a.username || '—')}</span>
      <span class="li-fill">↵ 回车或点击填充</span>
    </li>`;
  }).join('');
}

// 输入搜索（防抖）
let searchTimer = null;
els.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(refreshList, 180);
});

// 键盘：上下选、回车填充
els.search.addEventListener('keydown', (e) => {
  if (!allResults.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    activeIndex = (activeIndex + 1) % allResults.length;
    renderList(); scrollIntoActive();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeIndex = (activeIndex - 1 + allResults.length) % allResults.length;
    renderList(); scrollIntoActive();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const acc = allResults[activeIndex];
    if (acc) doFill(acc.id);
  }
});

function scrollIntoActive() {
  const el = els.list.querySelector('li.active');
  if (el) el.scrollIntoView({ block: 'nearest' });
}

// 点击列表项填充
els.list.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  doFill(li.dataset.id);
});

async function doFill(id) {
  // 1. 取完整账号（含解密密码）
  const res = await send({ type: 'GET_FULL', id });
  if (!res || !res.ok) {
    toast(res && res.error ? res.error : '取账号失败', 'err');
    return;
  }
  // 2. 取自定义 selector
  const selRes = await send({ type: 'GET_SELECTORS' });
  const selectors = (selRes && selRes.selectors) || {};

  // 3. 找到当前激活的税局 tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/guangdong\.chinatax\.gov\.cn/.test(tab.url || '')) {
    toast('请先打开广东电子税局登录页再填充', 'err');
    return;
  }

  // 4. 确保已注入 content（页面刚加载时 content 可能还没就绪）
  await ensureContentInjected(tab.id);

  // 5. 获取所有 frame，逐个发 FILL 消息，挑出真正填上的那个
  let best = null; // { filled:[], missed:[], diagnostics:[] }
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
    // 优先主帧，再子帧
    const sorted = (frames || []).sort((a, b) => (b.frameId === 0) - (a.frameId === 0));
    for (const f of sorted) {
      if (!/^https?:/.test(f.url || '')) continue;
      let r = null;
      try {
        r = await chrome.tabs.sendMessage(tab.id, {
          type: 'FILL', account: res.account, selectors,
        }, { frameId: f.frameId });
      } catch (e) { /* 该 frame 无 content 或跨域，跳过 */ continue; }
      if (r && r.filled && r.filled.length > 0) {
        best = r; break;
      } else if (r && r.diagnostics && (!best || (r.diagnostics.length > best.diagnostics.length))) {
        best = r; // 暂存诊断最全的失败结果
      }
    }
  } catch (e) {
    // webNavigation 不可用则退回普通发送
    try {
      best = await chrome.tabs.sendMessage(tab.id, {
        type: 'FILL', account: res.account, selectors,
      });
    } catch (e2) {
      toast('无法填充：' + (e2.message || e2), 'err');
      return;
    }
  }
  handleFillResult(best);
}

async function ensureContentInjected(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PING' }, { frameId: 0 });
  } catch (e) {
    // 未注入，主动注入
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ['content/matcher.js', 'content/content.js'],
      });
    } catch (e2) { /* 忽略，后面发消息会再次报错 */ }
  }
}

function handleFillResult(r) {
  if (!r) { toast('填充无响应', 'err'); return; }
  if (r.ok) {
    els.diag.classList.add('hidden');
    const filled = r.filled || [];
    toast('✓ 已填充：' + (filled.join('、') || '无'), 'ok');
    return;
  }
  // 部分失败：展示诊断
  const missed = r.missed || [];
  const diag = r.diagnostics || [];
  els.diagBody.textContent = [
    '未自动填充的字段：' + (missed.join('、') || '无'),
    '',
    '可在「设置」里为这些字段填写 CSS selector。',
    '页面候选 input 诊断信息（取前 20 个）：',
    ...diag.slice(0, 20).map((d) => `  - [${d.type || '?'}] placeholder="${d.placeholder||''}" id="${d.id||''}" name="${d.name||''}" aria="${d.aria||''}" label="${d.label||''}"`),
  ].join('\n');
  els.diag.classList.remove('hidden');
  toast('部分字段未填充，请查看诊断并设置 selector', 'err');
}

// ---------- 清空 ----------
els.btnClear.addEventListener('click', async () => {
  if (!confirm('确定清空全部账号？此操作不可恢复。')) return;
  await send({ type: 'CLEAR_ALL' });
  await refreshList();
  toast('已清空', 'ok');
});

// 列表项删除（右键 / 长按优化略，提供 shift+click 删除）
els.list.addEventListener('contextmenu', async (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  e.preventDefault();
  if (!confirm('删除该账号？')) return;
  await send({ type: 'DELETE_ACCOUNT', id: li.dataset.id });
  await refreshList();
  toast('已删除', 'ok');
});

// ---------- 设置 ----------
els.btnSettings.addEventListener('click', async () => {
  const show = els.settingsPanel.classList.toggle('hidden') === false;
  if (show) {
    const res = await send({ type: 'GET_SELECTORS' });
    const s = (res && res.selectors) || {};
    els.selCredit.value = s.creditCode || '';
    els.selUser.value = s.username || '';
    els.selPwd.value = s.password || '';
  }
});
$('#sel-save').addEventListener('click', async () => {
  await send({
    type: 'SET_SELECTORS',
    selectors: {
      creditCode: els.selCredit.value.trim(),
      username: els.selUser.value.trim(),
      password: els.selPwd.value.trim(),
    },
  });
  toast('已保存', 'ok');
});
$('#sel-close').addEventListener('click', () => els.settingsPanel.classList.add('hidden'));

// ---------- 工具 ----------
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function escapeAttr(s) {
  return String(s == null ? '' : s).replace(/["']/g, '');
}

// ---------- 更新检查 ----------
const upEls = {
  banner: $('#update-banner'),
  version: $('#ub-version'),
  note: $('#ub-note'),
  download: $('#ub-download'),
  close: $('#ub-close'),
  guide: $('#ub-guide'),
  guideModal: $('#guide-modal'),
  guideClose: $('#guide-close'),
  guideExtUrl: $('#guide-ext-url'),
  verTag: $('#ver-tag'),
};
let currentUpdateInfo = null;

// 显示版本号
upEls.verTag.textContent = 'v' + chrome.runtime.getManifest().version;

// 渲染横幅
function renderUpdateBanner(info) {
  currentUpdateInfo = info;
  if (info && info.latest) {
    upEls.version.textContent = 'v' + info.latest;
    upEls.note.textContent = info.note || '';
    upEls.banner.classList.remove('hidden');
  } else {
    upEls.banner.classList.add('hidden');
  }
}

// 打开侧边栏时：先用缓存快速展示，再后台静默检查一次
async function initUpdate() {
  const cached = await send({ type: 'GET_UPDATE_INFO' });
  if (cached && cached.hasUpdate && cached.info) {
    renderUpdateBanner(cached.info);
  }
  // 静默检查（不强制、不忽略 skip）
  const r = await send({ type: 'CHECK_UPDATE' });
  if (r && r.ok) {
    if (r.hasUpdate && r.info) renderUpdateBanner(r.info);
    else if (r.reason === 'up-to-date') renderUpdateBanner(null);
  }
}

// 一键下载更新包
upEls.download.addEventListener('click', async () => {
  if (!currentUpdateInfo || !currentUpdateInfo.url) {
    toast('暂无下载地址', 'err');
    return;
  }
  upEls.download.disabled = true;
  upEls.download.textContent = '正在下载…';
  const res = await send({
    type: 'DOWNLOAD_UPDATE',
    url: currentUpdateInfo.url,
    filename: `etax-assistant-v${currentUpdateInfo.latest}.zip`,
    saveAs: true, // 弹保存框，让会计能看到下载到哪
  });
  upEls.download.disabled = false;
  upEls.download.textContent = '⬇ 一键下载更新包';
  if (res && res.ok) {
    toast('已开始下载，请看浏览器下载提示', 'ok');
    upEls.guideModal.classList.remove('hidden'); // 自动弹出安装引导
  } else {
    toast('下载失败：' + (res && res.error || '未知错误') + '，请稍后重试或联系提供者', 'err');
  }
});

// 忽略本次（记到 skip，不再弹这个版本）
upEls.close.addEventListener('click', async () => {
  if (currentUpdateInfo && currentUpdateInfo.latest) {
    await send({ type: 'SKIP_VERSION', version: currentUpdateInfo.latest });
  }
  renderUpdateBanner(null);
  toast('已忽略该版本', '');
});

// 安装引导
upEls.guide.addEventListener('click', () => upEls.guideModal.classList.remove('hidden'));
upEls.guideClose.addEventListener('click', () => upEls.guideModal.classList.add('hidden'));
// 点击弹层背景关闭
upEls.guideModal.addEventListener('click', (e) => {
  if (e.target === upEls.guideModal) upEls.guideModal.classList.add('hidden');
});
// chrome:// 链接在普通页面打不开，引导用户复制
upEls.guideExtUrl.addEventListener('click', (e) => {
  e.preventDefault();
  // 尝试用 tabs.create 打开（可能被拦截），失败则提示复制
  chrome.tabs.create({ url: 'chrome://extensions/' }).catch(() => {
    prompt('Chrome 限制了自动打开该页面，请复制下面地址到地址栏回车：', 'chrome://extensions/');
  });
});

// ---------- 初始化 ----------
refreshList();
initUpdate();
