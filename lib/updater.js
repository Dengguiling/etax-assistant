// updater.js —— 自更新检测模块
// 机制：fetch 版本元数据（update.json）→ 与本地版本对比 → 有新版则记录到 storage，
//       并通过 action badge / notification 提示用户；用户在侧边栏点「一键下载更新包」。
//
// 为什么不静默更新：Chrome MV3 禁止第三方扩展静默替换自身（非商店场景），
// 必须用户参与。本模块只负责"检测+引导"，实际重载由用户照图文提示完成。
//
// 通过 importScripts（background）或 <script>（sidepanel）加载，暴露 global.EtaxUpdater。

(function (global) {
  'use strict';

  // ====== 配置（改这一行即可切换分发源，如 Gitee 镜像）======
  // UPDATE_JSON_URL：版本元数据地址
  //   形如：https://github.com/<owner>/<repo>/releases/latest/download/update.json
  //        GitHub 会自动 latest download 重定向到最新 release 的附件。
  // zip 的实际地址放在 update.json 里，避免硬编码到代码。
  const UPDATE_JSON_URL = 'https://github.com/Dengguiling/etax-assistant/releases/latest/download/update.json';

  const STORAGE_KEY = '__update_info__';   // 缓存的最新版本信息
  const LAST_CHECK_KEY = '__update_last_check__'; // 上次检查时间戳
  const SKIP_VERSION_KEY = '__update_skip__'; // 用户主动忽略的版本

  // 版本号比较：支持 "1.0.0" / "1.2.10" 等 x.y.z 格式
  // 返回: 1 表示 a 更新，-1 表示 b 更新，0 相同
  function compareVersion(a, b) {
    const pa = String(a || '0').split('.');
    const pb = String(b || '0').split('.');
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const na = parseInt(pa[i] || '0', 10);
      const nb = parseInt(pb[i] || '0', 10);
      if (na > nb) return 1;
      if (na < nb) return -1;
    }
    return 0;
  }

  function currentVersion() {
    return chrome.runtime.getManifest().version || '0.0.0';
  }

  async function getCached() {
    const got = await chrome.storage.local.get([STORAGE_KEY, SKIP_VERSION_KEY]);
    const info = got[STORAGE_KEY] || null;
    const skip = got[SKIP_VERSION_KEY] || '';
    return { info, skip };
  }

  async function setCached(info) {
    await chrome.storage.local.set({ [STORAGE_KEY]: info, [LAST_CHECK_KEY]: Date.now() });
  }

  // 拉取远程元数据。返回 { latest, url, size?, note?, sha256?, publishedAt? } 或 null
  async function fetchUpdate(timeoutMs = 12000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(UPDATE_JSON_URL, {
        cache: 'no-store',
        signal: ctrl.signal,
        redirect: 'follow',
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || !data.latest || !data.url) return null;
      return {
        latest: String(data.latest).trim(),
        url: String(data.url).trim(),
        size: data.size || null,
        note: data.note || '',
        sha256: data.sha256 || '',
        publishedAt: data.publishedAt || '',
      };
    } catch (e) {
      return null; // 网络问题（国内访问 GitHub 不稳）：静默失败
    } finally {
      clearTimeout(t);
    }
  }

  // 执行一次检查。返回 { hasUpdate, info, reason }
  // reason: 'up-to-date' | 'new-version' | 'skipped' | 'fetch-failed'
  async function check(force) {
    const cur = currentVersion();
    const remote = await fetchUpdate();
    if (!remote) {
      return { hasUpdate: false, info: null, reason: 'fetch-failed' };
    }
    const cmp = compareVersion(remote.latest, cur);
    const isNew = cmp > 0;
    if (!isNew) {
      await setCached({ ...remote, seenAt: Date.now() });
      return { hasUpdate: false, info: remote, reason: 'up-to-date' };
    }
    // 有新版，但用户可能主动忽略了该版本
    const { skip } = await getCached();
    if (!force && skip === remote.latest) {
      return { hasUpdate: false, info: remote, reason: 'skipped' };
    }
    await setCached({ ...remote, seenAt: Date.now() });
    return { hasUpdate: true, info: remote, reason: 'new-version' };
  }

  // 设置扩展图标角标提示（badge）
  function setBadge(on) {
    try {
      if (chrome.action && chrome.action.setBadgeText) {
        chrome.action.setBadgeText({ text: on ? 'NEW' : '' });
        chrome.action.setBadgeBackgroundColor({ color: '#f56c6c' });
      }
    } catch (e) { /* ignore */ }
  }

  // 发桌面通知（点击后打开侧边栏看详情）
  async function notify(info) {
    if (!chrome.notifications || !chrome.notifications.create) return;
    const note = info.note ? ('\n' + info.note) : '';
    chrome.notifications.create('etax-update', {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: '电子税局助手发现新版本 v' + info.latest,
      message: '点击查看更新说明，并一键下载更新包。' + note,
      priority: 2,
      requireInteraction: false,
    });
  }

  async function skipVersion(version) {
    await chrome.storage.local.set({ [SKIP_VERSION_KEY]: String(version || '') });
    setBadge(false);
  }

  async function clearSkip() {
    await chrome.storage.local.remove(SKIP_VERSION_KEY);
  }

  global.EtaxUpdater = {
    UPDATE_JSON_URL,
    compareVersion,
    currentVersion,
    getCached,
    check,
    setBadge,
    notify,
    skipVersion,
    clearSkip,
  };
})(typeof self !== 'undefined' ? self : window);
