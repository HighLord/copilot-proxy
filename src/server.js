'use strict';

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const config = require('./config');
const auth = require('./authManager');
const { sign, verify } = require('./sessionSecret');
const realClient = require('./copilotClient');
const mockClient = require('./mockClient');
const conversations = require('./conversationStore');
const adminStore = require('./adminStore');
const userStore = require('./userStore');
const { buildPreamble, composeMessage, hashText } = require('./prompts');

const { streamChat, CopilotError } = config.MOCK ? mockClient : realClient;

const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_INTERNAL_ERROR = 500;
const { UUID_PATTERN } = conversations;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: config.JSON_BODY_LIMIT }));

// ---------- session cookie ----------

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key && !(key in out)) {
      try { out[key] = decodeURIComponent(value); } catch { out[key] = value; }
    }
  }
  return out;
}

function safeEqual(provided, expected) {
  const a = crypto.createHash('sha256').update(String(provided)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function setSessionCookie(res, email) {
  res.setHeader('Set-Cookie',
    `${config.SESSION_COOKIE_NAME}=${encodeURIComponent(email)}.${sign(email)}; HttpOnly; Path=/; Max-Age=${Math.floor(config.SESSION_TTL_MS / 1000)}; SameSite=Lax`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${config.SESSION_COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

function currentUser(req) {
  const raw = parseCookies(req.headers.cookie)[config.SESSION_COOKIE_NAME];
  if (!raw) return null;
  const idx = raw.lastIndexOf('.');
  if (idx < 0) return null;
  let email;
  try { email = decodeURIComponent(raw.slice(0, idx)); } catch { return null; }
  const sig = raw.slice(idx + 1);
  return verify(email, sig) ? email.toLowerCase() : null;
}

function requireSession(req, res, next) {
  const email = currentUser(req);
  if (!email) {
    res.status(HTTP_UNAUTHORIZED).json({ error: 'Not signed in', needsLogin: true });
    return;
  }
  req.userEmail = email;
  next();
}

// Admin routes need a valid session, plus ADMIN_API_KEY when one is configured.
function requireAdmin(req, res, next) {
  requireSession(req, res, () => {
    if (config.ADMIN_API_KEY && !safeEqual(req.get('x-admin-key') ?? '', config.ADMIN_API_KEY)) {
      res.status(HTTP_FORBIDDEN).json({ error: 'Admin key required' });
      return;
    }
    next();
  });
}

const handler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// ---------- SSE helpers ----------

function sendSse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ---------- auth (public) ----------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.get('/api/auth/status', (req, res) => {
  const email = currentUser(req);
  if (!email) return res.json({ signedIn: false, mock: config.MOCK });
  const st = auth.getStatus(email);
  return res.json({ signedIn: st.set && !st.expired, email, name: st.name, expiresAt: st.expiresAt, mock: config.MOCK });
});

app.post('/api/auth/login', handler(async (req, res) => {
  const email = String(req.body?.email ?? '').trim();
  if (!EMAIL_RE.test(email)) throw httpError(HTTP_BAD_REQUEST, 'Enter a valid email address');
  const flow = await auth.startLogin(email);
  if (flow.state === 'done') setSessionCookie(res, flow.email);
  res.json({ loginId: flow.id, state: flow.state, email: flow.email, name: flow.name, error: flow.error });
}));

app.post('/api/auth/password', handler(async (req, res) => {
  const { loginId, password } = req.body ?? {};
  if (!loginId || typeof password !== 'string' || !password) throw httpError(HTTP_BAD_REQUEST, 'Password required');
  const flow = await auth.submitPassword(loginId, password);
  if (flow.state === 'done') setSessionCookie(res, flow.email);
  res.json({ state: flow.state, email: flow.email, name: flow.name, error: flow.error });
}));

app.post('/api/auth/mfa', handler(async (req, res) => {
  const { loginId, code } = req.body ?? {};
  if (!loginId || typeof code !== 'string' || !code.trim()) throw httpError(HTTP_BAD_REQUEST, 'Code required');
  const flow = await auth.submitMfa(loginId, code.trim());
  if (flow.state === 'done') setSessionCookie(res, flow.email);
  res.json({ state: flow.state, email: flow.email, name: flow.name, error: flow.error });
}));

app.post('/api/auth/cancel', (req, res) => {
  auth.cancel(req.body?.loginId);
  res.json({ ok: true });
});

app.post('/api/auth/signout', (req, res) => {
  const email = currentUser(req);
  if (email) auth.dropSession(email);
  clearSessionCookie(res);
  res.json({ ok: true });
});

// ---------- REST: bootstrap, conversations, preferences, memory ----------

const api = express.Router();
api.use(requireSession);

api.param('id', (_req, _res, next, id) => {
  next(UUID_PATTERN.test(id) ? undefined : httpError(HTTP_BAD_REQUEST, 'id must be a UUID'));
});

api.get('/bootstrap', (req, res) => {
  const admin = adminStore.getAdmin();
  const st = auth.getStatus(req.userEmail);
  res.json({
    appName: admin.appName,
    defaultMode: admin.defaultMode,
    modes: Object.entries(admin.modes).map(([id, mode]) => ({ id, label: mode.label, description: mode.description })),
    starters: admin.starters,
    preferences: userStore.publicPreferences(req.userEmail),
    identity: { email: req.userEmail, name: st.name },
    maxPromptChars: config.MAX_PROMPT_CHARS,
    adminKeyRequired: Boolean(config.ADMIN_API_KEY),
    mock: config.MOCK,
  });
});

api.get('/conversations', (req, res) => res.json({ conversations: conversations.list(req.userEmail) }));

api.get('/conversations/:id', handler(async (req, res) => {
  const conv = await conversations.get(req.userEmail, req.params.id);
  if (!conv) throw httpError(HTTP_NOT_FOUND, 'Conversation not found');
  const { injectedHash, ...visible } = conv;
  res.json(visible);
}));

api.patch('/conversations/:id', handler(async (req, res) => {
  const { title, pinned } = req.body ?? {};
  if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.length > config.MAX_TITLE_CHARS)) {
    throw httpError(HTTP_BAD_REQUEST, `title must be 1-${config.MAX_TITLE_CHARS} characters`);
  }
  if (pinned !== undefined && typeof pinned !== 'boolean') {
    throw httpError(HTTP_BAD_REQUEST, 'pinned must be true or false');
  }
  const conv = await conversations.mutate(req.userEmail, req.params.id, (c) => {
    if (title !== undefined) c.title = title.trim();
    if (pinned !== undefined) c.pinned = pinned;
  });
  if (!conv) throw httpError(HTTP_NOT_FOUND, 'Conversation not found');
  res.json({ ok: true, title: conv.title, pinned: Boolean(conv.pinned) });
}));

api.delete('/conversations/:id', handler(async (req, res) => {
  if (!(await conversations.remove(req.userEmail, req.params.id))) throw httpError(HTTP_NOT_FOUND, 'Conversation not found');
  res.json({ ok: true });
}));

api.delete('/conversations', handler(async (req, res) => {
  res.json({ ok: true, deleted: await conversations.removeAll(req.userEmail) });
}));

api.get('/preferences', (req, res) => res.json(userStore.publicPreferences(req.userEmail)));
api.put('/preferences', (req, res) => res.json(userStore.updatePreferences(req.userEmail, req.body)));

api.get('/memories', (req, res) => res.json({ memories: userStore.listMemories(req.userEmail) }));
api.post('/memories', (req, res) => res.status(201).json(userStore.addMemory(req.userEmail, req.body?.text)));
api.patch('/memories/:id', (req, res) => {
  const memory = userStore.updateMemory(req.userEmail, req.params.id, req.body?.text);
  if (!memory) throw httpError(HTTP_NOT_FOUND, 'Memory not found');
  res.json(memory);
});
api.delete('/memories/:id', (req, res) => {
  if (!userStore.deleteMemory(req.userEmail, req.params.id)) throw httpError(HTTP_NOT_FOUND, 'Memory not found');
  res.json({ ok: true });
});
api.delete('/memories', (req, res) => {
  userStore.clearMemories(req.userEmail);
  res.json({ ok: true });
});

app.use('/api', api);

// ---------- admin ----------

const adminApi = express.Router();
adminApi.use(requireAdmin);
adminApi.get('/settings', (_req, res) => res.json(adminStore.getAdmin()));
adminApi.put('/settings', (req, res) => res.json(adminStore.updateAdmin(req.body)));
adminApi.post('/settings/reset', (_req, res) => res.json(adminStore.resetAdmin()));
app.use('/api/admin', adminApi);

// ---------- chat ----------

// Conversations with a turn in flight. A second turn on the same conversation would interleave replies.
const inFlight = new Set();

function makeTitle(prompt) {
  const oneLine = prompt.replace(/\s+/g, ' ').trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 57).trimEnd()}...` : oneLine;
}

function badRequest(res, message) {
  res.status(HTTP_BAD_REQUEST).json({ error: message });
}

app.post('/chat', requireSession, async (req, res) => {
  const { prompt, conversationId: requestedId, mode: requestedMode } = req.body ?? {};
  const admin = adminStore.getAdmin();

  if (typeof prompt !== 'string' || prompt.trim() === '' || prompt.length > config.MAX_PROMPT_CHARS) {
    badRequest(res, `prompt must be a non-empty string up to ${config.MAX_PROMPT_CHARS} characters`);
    return;
  }
  if (requestedId !== undefined && !UUID_PATTERN.test(String(requestedId))) {
    badRequest(res, 'conversationId must be a UUID');
    return;
  }
  if (requestedMode !== undefined && !admin.modes[requestedMode]) {
    badRequest(res, `mode must be one of: ${Object.keys(admin.modes).join(', ')}`);
    return;
  }

  let session;
  if (!config.MOCK) {
    try {
      session = auth.getSession(req.userEmail);
    } catch (error) {
      res.status(error.status ?? HTTP_UNAUTHORIZED).json({ error: error.message, needsLogin: Boolean(error.needsLogin) });
      return;
    }
  }

  const conversationId = String(requestedId ?? crypto.randomUUID()).toLowerCase();
  if (inFlight.has(conversationId)) {
    res.status(HTTP_CONFLICT).json({ error: 'This conversation is still answering the previous message' });
    return;
  }

  const modeId = requestedMode ?? admin.defaultMode;
  const modeConfig = { ...admin.modes[modeId], id: modeId };

  // Instructions are sent when the conversation starts and again whenever they change, because
  // Copilot keeps the earlier turns on its side and would otherwise never see the update.
  const preamble = buildPreamble({ admin, user: userStore.getUser(req.userEmail), modeId });
  const preambleHash = preamble ? hashText(preamble) : null;

  inFlight.add(conversationId);
  try {
    const existing = await conversations.get(req.userEmail, conversationId);
    const isNew = !existing;
    const needsPreamble = Boolean(preamble) && existing?.injectedHash !== preambleHash;
    const message = composeMessage({
      preamble: needsPreamble ? preamble : '',
      prompt,
      isUpdate: needsPreamble && (existing?.messages.length ?? 0) > 0,
    });
    if (message.length > config.MAX_PROMPT_CHARS) {
      badRequest(
        res,
        `Message plus instructions and memory is ${message.length} characters; the limit is ${config.MAX_PROMPT_CHARS}. `
          + `Instructions and memory use ${message.length - prompt.length}. Shorten the message or trim memory.`,
      );
      return;
    }

    const userMessage = { id: crypto.randomUUID(), role: 'user', text: prompt, createdAt: new Date().toISOString() };
    const assistantMessageId = crypto.randomUUID();
    await conversations.create(req.userEmail, conversationId);
    const afterUser = await conversations.mutate(req.userEmail, conversationId, (conv) => {
      if (conv.messages.length === 0) conv.title = makeTitle(prompt);
      conv.messages.push(userMessage);
    }, { touch: true });

    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    sendSse(res, 'meta', {
      conversationId,
      isNew,
      title: afterUser?.title ?? 'New chat',
      mode: modeId,
      userMessageId: userMessage.id,
      assistantMessageId,
    });

    const abortController = new AbortController();
    res.on('close', () => abortController.abort());
    // Proxies close idle connections; a comment line keeps long "think deeper" runs alive.
    const heartbeat = setInterval(() => res.write(': ping\n\n'), config.SSE_HEARTBEAT_MS);

    const startedAt = Date.now();
    let text = '';
    let outcome = 'complete';
    let failure = null;
    try {
      await streamChat({
        session,
        prompt: message,
        conversationId,
        mode: modeConfig,
        signal: abortController.signal,
        onDelta: (delta) => {
          text += delta;
          sendSse(res, 'delta', { text: delta });
        },
        onStatus: (status) => sendSse(res, 'status', status),
      });
    } catch (error) {
      failure = error;
      outcome = abortController.signal.aborted ? 'stopped' : 'error';
    } finally {
      clearInterval(heartbeat);
    }

    // A failed turn that produced nothing leaves no trace, so the user can simply resend.
    const rollBack = outcome === 'error' && text === '';
    let nothingLeft = false;
    const saved = await conversations.mutate(req.userEmail, conversationId, (conv) => {
      if (rollBack) {
        conv.messages = conv.messages.filter((m) => m.id !== userMessage.id);
        nothingLeft = conv.messages.length === 0;
        return;
      }
      const reply = {
        id: assistantMessageId,
        role: 'assistant',
        text,
        mode: modeId,
        status: outcome,
        createdAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
      };
      if (outcome === 'error') reply.error = failure.message;
      conv.messages.push(reply);
      if (needsPreamble) conv.injectedHash = preambleHash;
    }, { touch: !rollBack });
    const conversationDeleted = nothingLeft && isNew;
    if (conversationDeleted) await conversations.remove(req.userEmail, conversationId);

    if (!res.writableEnded) {
      if (outcome === 'error') {
        const status = failure instanceof CopilotError ? failure.status : HTTP_INTERNAL_ERROR;
        sendSse(res, 'error', { status, message: failure.message, persisted: !rollBack, conversationDeleted });
      } else {
        sendSse(res, 'done', { assistantMessageId, title: saved?.title, status: outcome });
      }
    }
    res.end();
  } catch (error) {
    console.error('chat failed:', error);
    if (res.headersSent) {
      if (!res.writableEnded) sendSse(res, 'error', { status: HTTP_INTERNAL_ERROR, message: 'Internal error', persisted: false });
      res.end();
    } else {
      res.status(HTTP_INTERNAL_ERROR).json({ error: 'Internal error' });
    }
  } finally {
    inFlight.delete(conversationId);
  }
});

// ---------- static UI ----------

app.get('/health', (_req, res) => res.json({ ok: true }));

const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir, { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
// The UI used to live at /test.
app.get('/test', (_req, res) => res.redirect('/'));

// ---------- errors ----------

// eslint-disable-next-line no-unused-vars
app.use((error, _req, res, _next) => {
  const status = error.status ?? HTTP_INTERNAL_ERROR;
  if (status >= HTTP_INTERNAL_ERROR) console.error(error);
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(status).json({ error: status >= HTTP_INTERNAL_ERROR ? 'Internal error' : error.message });
});

if (require.main === module) {
  const server = app.listen(config.PORT, () => {
    console.log(`copilot-proxy listening on port ${config.PORT}${config.MOCK ? ' (MOCK Copilot)' : ''}`);
  });
  const shutdown = () => {
    auth.dispose();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = app;
