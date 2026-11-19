# copilot-proxy

A self-hosted web UI for M365 Copilot Chat. Sign in with your Microsoft account and it
streams Copilot replies through a Claude-style chat interface — no API key, no manual
token copying.

## How it works

1. You sign in with your Microsoft account. The server drives a real (headless) Chromium
   through `copilot.cloud.microsoft`, completes the sign-in, and captures the Copilot chat
   `access_token` from the Chathub WebSocket URL automatically.
2. The browser's cookies are kept per account, so the next time the token expires the
   server re-opens the browser and refreshes it silently. You are only asked for the
   password again when the saved session has fully expired or sign-in fails.
3. Identity is your email address. Every user gets their own preferences, memory and
   conversation history under `data/users/<hash>/`. Admin customizations (system prompt,
   modes, starters) are shared globally in `data/admin.json`.

The `access_token` is a short-lived credential and is stored on disk under
`data/auth/sessions/` so the server can keep working across restarts. Treat the `data/`
directory as secret.

## Model selection

The chat mode (Quick / Think) maps to Copilot's `tone` field on the wire, captured from the
browser: `Gpt_5_6_Chat` = quick response, `Gpt_5_6_Reasoning` = think. Both report the model
identity "GPT-5.6" — think vs quick is a reasoning-mode switch, not a different base model. The
tone is editable per mode in the Admin panel.

Over the API, any model name is accepted: `copilot` / `gpt-5.6` = quick, `copilot-deep` /
`gpt-5.6-think` / `copilot-think` = think (any name containing `deep`/`think`/`reason` also picks
think). The selected model is echoed back in responses.

## Reasoning / thinking

Copilot does not stream chain-of-thought, but it does emit progress and search status messages.
Those are surfaced as "reasoning": the chat UI shows them in a collapsible *Thought process*
block, the OpenAI-compatible API streams them as `delta.reasoning_content` (and
`message.reasoning_content` non-streaming), and the Anthropic-compatible API emits `thinking`
blocks.

## File attachments

Copilot has no direct file upload over the WebSocket. Files are uploaded to the "Microsoft
Copilot Chat Files" library via Graph, then referenced in the message as a `LocalFile` annotation
(the exact annotation id format was reverse-engineered from a captured session and is verified by
the test suite). Upload with `POST /v1/files?filename=name.pdf` (raw bytes) or
`POST /api/upload?name=name.pdf`; pass the returned annotation through the `attachments` array of
a chat request. Uploads require the M365Chat refresh token (captured from MSAL at sign-in) to
obtain a Files-scoped Graph token.

## Requirements

- Node.js >= 20.6
- `npm install` then `npx playwright install chromium`

## Run

```bash
npm install
npx playwright install chromium
npm start
```

Then open http://localhost:3000 and sign in.

## Configuration (.env)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | Where all state is stored |
| `ADMIN_API_KEY` | *(unset)* | When set, the Admin tab asks for this key |
| `COPILOT_MOCK` | `0` | `1` = local mock Copilot + mock sign-in (no account needed) |
| `COPILOT_LOGIN_URL` | `https://copilot.cloud.microsoft` | Entry page for sign-in |
| `COPILOT_HEADLESS` | *(unset)* | `1` hides the sign-in browser; the default shows it |
| `COPILOT_CHATHUB_WS_HOST` | `substrate.office.com` | Host whose WebSocket carries the token |
| `COPILOT_DEBUG_FRAMES` | `0` | `1` logs SignalR frames (token redacted) |

## Troubleshooting

- **Sign-in gets stuck** — run with `COPILOT_HEADLESS=0` to watch the real browser and see
  which page it lands on. The Microsoft sign-in DOM changes occasionally; if a field is not
  found the server reports it in the sign-in dialog.
- **"Signed in, but the Copilot chat token could not be captured"** — retry once; the
  session is now remembered so the retry is instant. If it persists, open
  `copilot.cloud.microsoft` in that profile manually once (or use `COPILOT_HEADLESS=0`).
- **Mock mode** — `COPILOT_MOCK=1` skips Microsoft entirely. Password `mfa` exercises the
  two-step flow; the code is `123456`.
