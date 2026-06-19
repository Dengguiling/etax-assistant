// background.js —— MV3 service worker
// 职责：加解密、chrome.storage 读写、消息路由、点击图标打开 Side Panel、每日检查更新。
// 依赖 sidepanel/crypto.js、lib/updater.js（通过 importScripts 引入）。

importScripts('sidepanel/crypto.js', 'lib/updater.js');

const ACCOUNTS_KEY = 'accounts';
const SELECTORS_KEY = '__field_selectors__';
const ALARM_NAME = 'etax-daily-check';

// 点击扩展图标 -> 打开 Side Panel
chrome.runtime.onInstalled.addListener(async () => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  // 注册每日检查（安装/更新时立即检查一次）
  await chrome.alarms.create(ALARM_NAME, { delayInMinutes: 2, periodInMinutes: 60 * 24 });
  runUpdateCheck(false).catch(() => {});
});

// service worker 被唤醒时也补一次：若距上次检查超过 20 小时则检查
chrome.runtime.onStartup.addListener(() => {
  maybeCheckByInterval().catch(() => {});
});

async function maybeCheckByInterval() {
  const got = await chrome.storage.local.get('__update_last_check__');
  const last = got['__update_last_check__'] || 0;
  if (Date.now() - last > 20 * 60 * 60 * 1000) {
    await runUpdateCheck(false);
  }
}

// 每日定时触发
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === ALARM_NAME) {
    runUpdateCheck(false).catch(() => {});
  }
});

// 执行更新检测：有新版则角标提示 + 桌面通知
async function runUpdateCheck(force) {
  const r = await self.EtaxUpdater.check(force);
  if (r.hasUpdate && r.info) {
    self.EtaxUpdater.setBadge(true);
    self.EtaxUpdater.notify(r.info);
  } else if (r.reason === 'up-to-date' || r.reason === 'skipped') {
    self.EtaxUpdater.setBadge(false);
  }
  return r;
}

// 通知点击 -> 打开侧边栏看详情
if (chrome.notifications && chrome.notifications.onClicked) {
  chrome.notifications.onClicked.addListener((id) => {
    if (id !== 'etax-update') return;
    chrome.notifications.clear(id);
    // 打开侧边栏（需在 window 上下文，用 sidePanel.open）
    try { chrome.sidePanel.open(); } catch (e) {}
  });
}

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
        case 'CHECK_UPDATE': {
          // sidepanel 手动触发检查（force=true，忽略"已忽略版本"）
          const r = await runUpdateCheck(true);
          sendResponse({
            ok: true,
            hasUpdate: r.hasUpdate,
            info: r.info,
            reason: r.reason,
            currentVersion: self.EtaxUpdater.currentVersion(),
          });
          break;
        }
        case 'GET_UPDATE_INFO': {
          // 读取缓存的更新信息（侧边栏打开时快速展示）
          const { info, skip } = await self.EtaxUpdater.getCached();
          const hasUpdate = !!(info && self.EtaxUpdater.compareVersion(info.latest, self.EtaxUpdater.currentVersion()) > 0 && skip !== info.latest);
          sendResponse({
            ok: true,
            hasUpdate,
            info,
            currentVersion: self.EtaxUpdater.currentVersion(),
          });
          break;
        }
        case 'SKIP_VERSION': {
          await self.EtaxUpdater.skipVersion(msg.version);
          sendResponse({ ok: true });
          break;
        }
        case 'DOWNLOAD_UPDATE': {
          // 下载更新 zip 到用户下载目录，返回下载状态
          if (!msg.url) { sendResponse({ ok: false, error: '缺少下载地址' }); break; }
          try {
            const fileId = await chrome.downloads.download({
              url: msg.url,
              filename: msg.filename || 'etax-assistant-update.zip',
              saveAs: !!msg.saveAs,
            });
            sendResponse({ ok: true, downloadId: fileId });
          } catch (e) {
            sendResponse({ ok: false, error: String(e && e.message || e) });
          }
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
