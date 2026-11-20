# Copilot Proxy Bridge (browser extension)

Captures your signed-in Copilot session from **your own browser** and sends it to your self-hosted
`copilot-proxy`, so the server never has to launch Chromium (the source of the memory/CPU spike).

## What it captures

| Artifact | Used for | How |
| --- | --- | --- |
| Chathub `access_token` | Chat | Reads the `access_token` query param off the WebSocket handshake to `substrate.office.com`. |
| `copilot.cloud.microsoft` cookies | Deleting conversations | `chrome.cookies` API (reads HttpOnly cookies too). |
| MSAL refresh token + Files-scoped Graph token | File uploads | Content script reads `localStorage`/`sessionStorage` on `copilot.cloud.microsoft`. |
| `x-client-eligibility` / `x-session-id` | Delete flow context | `webRequest` headers off `/_serverFn/` calls. |

It POSTs everything to `<proxy>/api/auth/client`.

## Install

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** and pick this `extension/` folder.

## Configure

1. Click the extension icon, set the **Proxy URL** (default `http://localhost:3000`), and Save.
2. If the server sets `COPILOT_CLIENT_KEY`, put the same value in **Client key**.

## Use

1. Sign in to <https://copilot.cloud.microsoft> normally in this Chrome profile.
2. Send one Copilot message (this opens the Chathub WebSocket, which carries the token the extension
   captures). The popup shows green checkmarks once each artifact is captured.
3. Open the proxy web UI and sign in with the same email. The server finds the captured session and
   logs you in instantly — no password prompt, no server-side browser.

If you want to forbid the server from ever falling back to its own browser, set
`COPILOT_BROWSER_SIGNIN=0` on the server. Login then only works via a captured session.

## Notes

- The extension's `<all_urls>` host permission exists so it can (a) watch the `substrate.office.com`
  WebSocket, (b) read `copilot.cloud.microsoft` cookies, and (c) POST to whatever proxy URL you
  configure. It is a power-user tool for a self-hosted setup; load it only in a profile you trust.
- Tokens and cookies are short-lived. If the popup shows ✗ after a while, re-open Copilot and send a
  message so the token is re-captured, then click **Send session now**.
