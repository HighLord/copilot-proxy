'use strict';

// Copilot Proxy Bridge — service worker.
//
// Captures three things from the user's own browser and pushes them to the proxy's /api/auth/client:
//   1. The Chathub access_token (from the WebSocket handshake URL) — needed for chat.
//   2. The copilot.cloud.microsoft cookies — needed for the chat-history delete flow.
//   3. The MSAL refresh token + Files-scoped Graph token (from the content script) — needed for uploads.
//
// Nothing here touches the server's Chromium; the point is that the server no longer needs one.

const DEFAULTS = { targetUrl: 'http://localhost:3000', key: '' };

async function getConfig() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return { targetUrl: String(stored.targetUrl || DEFAULTS.targetUrl).replace(/\/+$/, ''), key: String(stored.key || '') };
}

async function getCapture() {
  const stored = await chrome.storage.local.get('capture');
  return stored.capture || {};
}

async function setCapture(partial) {
  const capture = { ...(await getCapture()), ...partial };
  await chrome.storage.local.set({ capture });
  return capture;
}

// base64url -> claims, returning null unless it looks like a Chathub token (oid/tid/exp present).
function decodeJwt(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
    const claims = JSON.parse(json);
    if (!claims.oid || !claims.tid || !claims.exp) return null;
    return claims;
  } catch {
    return null;
  }
}

async function pushToProxy() {
  const capture = await getCapture();
  if (!capture.token) return { ok: false, error: 'No token captured yet' };
  const { targetUrl, key } = await getConfig();
  const headers = { 'content-type': 'application/json' };
  if (key) headers['x-client-key'] = key;
  const payload = {
    token: capture.token,
    email: capture.email || '',
    serverFnCookies: capture.serverFnCookies || '',
    refreshToken: capture.refreshToken || '',
    graphToken: capture.graphToken || '',
    graphTokenExp: capture.graphTokenExp ?? null,
    spoHost: capture.spoHost || '',
    clientEligibility: capture.clientEligibility || '',
    serverFnSessionId: capture.serverFnSessionId || '',
    chatSyncState: capture.chatSyncState || '',
  };
  try {
    const res = await fetch(`${targetUrl}/api/auth/client`, { method: 'POST', headers, body: JSON.stringify(payload) });
    return { ok: res.ok, status: res.status, body: await res.text() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function maybePush() {
  const capture = await getCapture();
  if (!capture.token) return;
  const result = await pushToProxy();
  await setCapture({ lastPush: { at: Date.now(), ok: result.ok, detail: result.ok ? 'sent' : (result.error || `HTTP ${result.status}`) } });
}

// 1. The Chathub access_token arrives in the query string of the WebSocket handshake (or, on some
//    builds, a fetch/XHR to substrate.office.com). Validate it decodes to a real token before use.
chrome.webRequest.onBeforeRequest.addListener((details) => {
  try {
    const url = new URL(details.url);
    const token = url.searchParams.get('access_token');
    if (!token) return;
    const claims = decodeJwt(token);
    if (!claims) return;
    const email = String(claims.upn || claims.email || claims.preferred_username || '').toLowerCase();
    const name = claims.name
      || (claims.given_name && claims.family_name ? `${claims.given_name} ${claims.family_name}` : '')
      || (email ? email.split('@')[0] : '');
    setCapture({ token, email, name }).then(maybePush);
  } catch { /* ignore */ }
}, { urls: ['wss://*/*', '*://substrate.office.com/*'] });

// 2. The x-client-eligibility and x-session-id headers from serverFn calls (used by the delete flow).
chrome.webRequest.onSendHeaders.addListener((details) => {
  try {
    if (!new URL(details.url).pathname.includes('/_serverFn/')) return;
    const patch = {};
    for (const header of details.requestHeaders ?? []) {
      const name = header.name.toLowerCase();
      if (name === 'x-client-eligibility' && !patch.clientEligibility) patch.clientEligibility = header.value;
      if (name === 'x-session-id' && !patch.serverFnSessionId) patch.serverFnSessionId = header.value;
    }
    if (Object.keys(patch).length) setCapture(patch).then(maybePush);
  } catch { /* ignore */ }
}, { urls: ['*://copilot.cloud.microsoft/*'] }, ['requestHeaders']);

// Cookies for copilot.cloud.microsoft (including parent-domain auth cookies) — the delete flow.
async function captureCookies() {
  try {
    const cookies = await chrome.cookies.getAll({ url: 'https://copilot.cloud.microsoft' });
    if (!cookies.length) return;
    const header = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    await setCapture({ serverFnCookies: header });
    await maybePush();
  } catch { /* ignore */ }
}

chrome.cookies.onChanged.addListener((changeInfo) => {
  if (String(changeInfo.cookie?.domain ?? '').includes('copilot.cloud.microsoft') || String(changeInfo.cookie?.domain ?? '').includes('microsoft.com')) {
    captureCookies();
  }
});

// Messages from the content script (MSAL refresh + Graph token) and the popup.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'copilot-msal') {
    setCapture(message.data || {}).then(maybePush);
    sendResponse({ ok: true });
    return;
  }
  if (message?.type === 'copilot-status') {
    Promise.all([getConfig(), getCapture()]).then(([config, capture]) => sendResponse({ config, capture }));
    return true; // async response
  }
  if (message?.type === 'copilot-save-config') {
    chrome.storage.local.set({ targetUrl: message.targetUrl, key: message.key }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === 'copilot-capture-cookies') {
    captureCookies().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === 'copilot-push') {
    pushToProxy().then((result) => sendResponse(result));
    return true;
  }
});

// On startup, grab cookies in case the user is already signed in.
captureCookies();
