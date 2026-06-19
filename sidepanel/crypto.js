// crypto.js —— AES-GCM 加解密封装（Web Crypto API，无第三方依赖）
// 仅对密码字段加密；公司名 / 信用代码 / 用户名明文存储以便搜索展示。
//
// 暴露到 window.EtaxCrypto，供 sidepanel.js 与 background.js 复用。

(function (global) {
  'use strict';

  const KEY_STORAGE = '__enc_key__'; // chrome.storage 中的密钥字段名
  const ALGO = 'AES-GCM';
  const KEY_LEN = 256;
  const IV_LEN = 12; // 96-bit IV（GCM 推荐）

  // ---- base64 <-> ArrayBuffer ----
  function bufToB64(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function b64ToBuf(b64) {
    const s = atob(b64);
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return bytes.buffer;
  }

  function toBytes(str) {
    return new TextEncoder().encode(str);
  }
  function fromBytes(bytes) {
    return new TextDecoder().decode(bytes);
  }

  // 读取或生成主密钥。service worker 会休眠，每次用前 ensure 一次。
  // 返回 CryptoKey。
  async function ensureKey() {
    const got = await chrome.storage.local.get(KEY_STORAGE);
    let key;
    if (got[KEY_STORAGE]) {
      key = await crypto.subtle.importKey(
        'raw', b64ToBuf(got[KEY_STORAGE]), { name: ALGO }, false, ['encrypt', 'decrypt']
      );
    } else {
      key = await crypto.subtle.generateKey({ name: ALGO, length: KEY_LEN }, true, ['encrypt', 'decrypt']);
      const raw = await crypto.subtle.exportKey('raw', key);
      await chrome.storage.local.set({ [KEY_STORAGE]: bufToB64(raw) });
    }
    return key;
  }

  // 加密明文字符串 -> { iv, ct }（均为 base64）
  async function encrypt(plain) {
    if (plain == null) return null;
    const key = await ensureKey();
    const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
    const ct = await crypto.subtle.encrypt(
      { name: ALGO, iv }, key, toBytes(String(plain))
    );
    return { iv: bufToB64(iv), ct: bufToB64(ct) };
  }

  // 解密 { iv, ct } -> 明文字符串
  async function decrypt(payload) {
    if (!payload || !payload.iv || !payload.ct) return '';
    const key = await ensureKey();
    const plain = await crypto.subtle.decrypt(
      { name: ALGO, iv: new Uint8Array(b64ToBuf(payload.iv)) },
      key,
      b64ToBuf(payload.ct)
    );
    return fromBytes(new Uint8Array(plain));
  }

  global.EtaxCrypto = { ensureKey, encrypt, decrypt, KEY_STORAGE };
})(typeof window !== 'undefined' ? window : self);
