'use strict';

// Runs on copilot.cloud.microsoft and reads the MSAL cache the way the server's old Playwright
// scan did: a refresh token (key matching /refreshtoken/i), JWT access tokens, and the SharePoint
// my-site host. These enable file uploads. Content scripts share the page origin's localStorage, so
// this is the one thing the background worker cannot read directly.

(function () {
  try {
    const found = { refresh: null, jwts: [], spoHost: null };
    for (const store of [window.localStorage, window.sessionStorage]) {
      for (let i = 0; i < store.length; i += 1) {
        let key;
        let value;
        try {
          key = store.key(i);
          value = store.getItem(key);
        } catch {
          continue;
        }
        if (!key || !value) continue;
        if (!found.refresh && /refreshtoken/i.test(key)) found.refresh = value;
        if (value.split('.').length === 3 && value.length > 120) found.jwts.push(value);
        if (!found.spoHost) {
          const match = key.match(/([a-z0-9.-]+-my\.sharepoint\.com)/i);
          if (match) found.spoHost = match[1].toLowerCase();
        }
      }
    }

    let graphToken = null;
    let graphTokenExp = null;
    for (const jwt of found.jwts) {
      try {
        const b64 = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        const claims = JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '=')));
        const scp = `${claims.scp ?? ''} ${claims.roles ?? ''}`.toLowerCase();
        const aud = String(claims.aud ?? '').toLowerCase();
        const isFiles = /files\.readwrite|myfiles\.(read|write)|sites\.readwrite/i.test(scp);
        const isGraph = /graph\.microsoft\.com|sharepoint/i.test(aud);
        if (isFiles && (isGraph || scp.includes('files'))) {
          graphToken = jwt;
          graphTokenExp = claims.exp ?? null;
          break;
        }
      } catch { /* not a decodable JWT */ }
    }

    if (found.refresh || graphToken || found.spoHost) {
      chrome.runtime.sendMessage({
        type: 'copilot-msal',
        data: { refreshToken: found.refresh, graphToken, graphTokenExp, spoHost: found.spoHost },
      }).catch(() => {});
    }
  } catch { /* ignore */ }
})();
