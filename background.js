// background.js —— MV3 service worker
// 职责：加解密、chrome.storage 读写、消息路由、点击图标打开 Side Panel。
// 加密依赖 sidepanel/crypto.js（通过 importScripts 引入）。

importScripts('sidepanel/crypto.js');

const ACCOUNTS_KEY = 'accounts';
const SELECTORS_KEY = '__field_selectors__';

// 点击扩展图标 -> 打开 Side Panel
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// 允许在税局域名下点击图标也能打开 Side Panel
chrome.tabs.onActivated.addListener(async (info) => {
  try {
    const tab = await chrome.tabs.get(info.tabId);
    if (tab.url && /guangdong\.chinatax\.gov\.cn/.test(tab.url)) {
      await chrome.sidePanel.setOptions({
        tabId: tab.id,
        path: 'sidepanel/sidepanel.html',
        enabled: true,
      });
    }
  } catch (e) { /* ignore */ }
});

// ---------- 工具函数 ----------
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function getAccountsList() {
  const got = await chrome.storage.local.get(ACCOUNTS_KEY);
  return Array.isArray(got[ACCOUNTS_KEY]) ? got[ACCOUNTS_KEY] : [];
}

async function saveAccountsList(list) {
  await chrome.storage.local.set({ [ACCOUNTS_KEY]: list });
}

// 脱敏后的账号（不含密码），用于列表展示 / 搜索
function toPublic(acc) {
  return { id: acc.id, company: acc.company, creditCode: acc.creditCode, username: acc.username };
}

// 模糊搜索：公司名 / 信用代码 / 用户名 任一包含 query（大小写、空格不敏感）
function searchIn(list, query) {
  const q = String(query || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!q) return list.map(toPublic);
  return list
    .filter((a) => {
      const hay = (
        (a.company || '') + (a.creditCode || '') + (a.username || '')
      ).toLowerCase().replace(/\s+/g, '');
      return hay.includes(q);
    })
    .map(toPublic);
}

// ---------- 消息路由 ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case 'IMPORT_ACCOUNTS': {
          // msg.rows: [{ company, creditCode, username, password }]
          const rows = Array.isArray(msg.rows) ? msg.rows : [];
          const list = await getAccountsList();
          let added = 0, updated = 0;
          for (const r of rows) {
            const company = String(r.company || '').trim();
            const creditCode = String(r.creditCode || '').trim();
            const username = String(r.username || '').trim();
            const password = String(r.password || '');
            if (!company && !creditCode && !username) continue;
            const passwordEnc = password ? await self.EtaxCrypto.encrypt(password) : null;
            // 以"信用代码"为主键去重（无则用公司名）
            const idx = list.findIndex((x) =>
              (x.creditCode && x.creditCode === creditCode) ||
              (!x.creditCode && x.company === company)
            );
            const rec = {
              id: idx >= 0 ? list[idx].id : uid(),
              company, creditCode, username, passwordEnc,
            };
            if (idx >= 0) { list[idx] = rec; updated++; }
            else { list.push(rec); added++; }
          }
          await saveAccountsList(list);
          sendResponse({ ok: true, added, updated, total: list.length });
          break;
        }
        case 'LIST_ALL': {
          const list = await getAccountsList();
          sendResponse({ ok: true, accounts: list.map(toPublic) });
          break;
        }
        case 'SEARCH': {
          const list = await getAccountsList();
          sendResponse({ ok: true, results: searchIn(list, msg.query) });
          break;
        }
        case 'GET_FULL': {
          // 返回解密后的完整账号（含明文密码），仅用于填充当前页
          const list = await getAccountsList();
          const acc = list.find((x) => x.id === msg.id);
          if (!acc) { sendResponse({ ok: false, error: '未找到该账号' }); break; }
          let password = '';
          if (acc.passwordEnc) password = await self.EtaxCrypto.decrypt(acc.passwordEnc);
          sendResponse({
            ok: true,
            account: { company: acc.company, creditCode: acc.creditCode, username: acc.username, password },
          });
          break;
        }
        case 'DELETE_ACCOUNT': {
          const list = await getAccountsList();
          const next = list.filter((x) => x.id !== msg.id);
          await saveAccountsList(next);
          sendResponse({ ok: true, total: next.length });
          break;
        }
        case 'CLEAR_ALL': {
          await saveAccountsList([]);
          sendResponse({ ok: true });
          break;
        }
        case 'GET_SELECTORS': {
          const got = await chrome.storage.local.get(SELECTORS_KEY);
          sendResponse({
            ok: true,
            selectors: got[SELECTORS_KEY] || { creditCode: '', username: '', password: '' },
          });
          break;
        }
        case 'SET_SELECTORS': {
          await chrome.storage.local.set({ [SELECTORS_KEY]: msg.selectors });
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'unknown message: ' + (msg && msg.type) });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
  })();
  return true; // 异步响应
});
