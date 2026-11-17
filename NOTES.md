# Status & remaining work

_Last updated: 2026-11-17_

## Working
- Per-user Microsoft sign-in (Playwright), no API key. Identity = email from the captured Copilot token.
- Sign-in flow (headful by default): Copilot landing → "Sign in" → email (auto-filled) → password → MFA → chat. Verified through to the MFA step.
- Per-user preferences / memory / conversations under `data/users/<hash>/`; global admin settings in `data/admin.json`.
- Mock mode (`COPILOT_MOCK=1`) for deterministic testing.

## Remaining
1. **Token capture** — after sign-in the flow lands on the signed-in chat, but the Chathub
   WebSocket (`substrate.office.com`) carrying `access_token` is not observed within the
   capture window, so login ends with "could not capture the token". Diagnose where the token
   lives now (WS URL vs. SignalR negotiate response vs. MSAL storage) using a signed-in
   session, then fix `capture()` in `src/authManager.js`.
2. **Refresh token** — the Microsoft OAuth `refresh_token` is not yet captured/stored. Goal:
   keep it to refresh the Copilot token without re-driving the browser.

## How to resume
- `data/auth/` was cleared on 2026-11-17, so sign in fresh: start the server, open the app,
  complete the sign-in (enter the 2FA code when prompted).
- Then run the headful network diagnostic `tmp/diag3.js` against the signed-in profile to see
  the WebSocket / negotiate / storage traffic, and fix `capture()` accordingly.
