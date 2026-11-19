# Status & remaining work

_Last updated: 2026-11-19_

## Working
- Per-user Microsoft sign-in (Playwright), no API key. Identity = email from the captured Copilot token.
- Per-user preferences / memory / conversations under `data/users/<hash>/`; global admin settings in `data/admin.json`.
- Mock mode (`COPILOT_MOCK=1`) for deterministic testing.
- **Model selection** — the chat `tone` field now selects the mode on the wire: `Gpt_5_6_Chat`
  (quick) and `Gpt_5_6_Reasoning` (think), editable per mode in the Admin panel. API model aliases
  (`copilot`, `gpt-5.6`, `copilot-deep`, `gpt-5.6-think`, …) map to the same modes.
- **Reasoning surface** — Copilot's progress/search status messages are shown in the chat UI as a
  "Thought process" block, streamed as `reasoning_content` (OpenAI) / `thinking` blocks (Anthropic).
- **File uploads** — `POST /api/upload` and `POST /v1/files` upload to "Microsoft Copilot Chat
  Files" via Graph and attach as a `LocalFile` annotation (`attachments` array on `/chat` and the
  API). Annotation-id format verified against a captured HAR.
- **Delete sync (chat UI only)** — deleting a conversation in the chat UI also sends Copilot's
  `DeleteConversation` serverFn (TSS-framed, `x-route-id: chat-history`), auth'd by the
  `copilot.cloud.microsoft` session cookies captured at sign-in. Local delete is the source of
  truth; a Copilot sync failure is reported but never blocks the local delete. The `/v1` API is
  deliberately untouched.
- OpenAI- and Anthropic-compatible API under `/v1` (tool calling emulated via `<tool_call>` blocks).

## Remaining / needs a live smoke test
1. **Token capture (real sign-in)** — the Chathub WebSocket token capture after a real sign-in has
   not been re-verified since 2026-11-17. Sign in fresh and confirm the token is captured.
2. **Uploads end-to-end** — the Graph upload + MSAL refresh-token capture (`scanMsal` in
   `authManager.js`) is implemented but unverified against a real Microsoft account. Sign in, attach
   a file in the chat UI, and confirm Copilot actually reads it; if the annotation id does not
   resolve, the SPO id reconstruction in `src/upload.js` is the first place to look.
3. **Delete sync end-to-end** — the Copilot-side delete is wired but UNVERIFIED. The captured
   `DeleteConversation` request carries Copilot's whole chat-history state plus an IC3 sync
   watermark; this proxy sends a minimal state with the watermark captured at sign-in (or a fresh
   one). Whether Copilot accepts that is unknown. Sign in, delete a proxy chat, then check
   copilot.cloud.microsoft that it is gone. If it 409s or no-ops, the likely fix is to capture the
   full history state at sign-in (`flow.chatSyncState` only stores the watermark today) and replay
   the chat list in `src/historyClient.js`.

## How to resume
- Run `node --test test/compat.test.js` (35 tests) — all pass.
- Sign in fresh (start the server, open the app, complete sign-in incl. 2FA), then attach a file to
  verify the upload path against the real OneDrive/Graph flow, and delete a chat to verify the
  Copilot-side delete.
