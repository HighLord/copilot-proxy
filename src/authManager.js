'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { parseClaims, identityFromClaims } = require('./identity');
const { writeJsonAtomicSync, readJsonSync } = require('./fsUtil');

const AUTH_DIR = path.join(config.DATA_DIR, 'auth');
const SESSIONS_DIR = path.join(AUTH_DIR, 'sessions');
const PROFILES_DIR = path.join(AUTH_DIR, 'profiles');
fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.mkdirSync(PROFILES_DIR, { recursive: true });

class NeedsLoginError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NeedsLoginError';
    this.status = 401;
    this.needsLogin = true;
  }
}

class LoginError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LoginError';
    this.status = 400;
  }
}

const emailKey = (email) => crypto.createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex').slice(0, 32);
const sessionFile = (email) => path.join(SESSIONS_DIR, `${emailKey(email)}.json`);
const profileDir = (email) => path.join(PROFILES_DIR, emailKey(email));

// lowercased email -> { oid, tid, exp, email, name, token, savedAt }
const sessions = new Map();
// loginId -> in-flight login flow
const flows = new Map();

// ---------- session store ----------

function loadSessions() {
  for (const name of fs.readdirSync(SESSIONS_DIR)) {
    if (!name.endsWith('.json')) continue;
    const rec = readJsonSync(path.join(SESSIONS_DIR, name), null);
    if (rec && rec.email && rec.token) sessions.set(String(rec.email).toLowerCase(), rec);
  }
}

function saveSession(rec) {
  rec.email = String(rec.email).toLowerCase();
  writeJsonAtomicSync(sessionFile(rec.email), rec);
  sessions.set(rec.email, rec);
}

function sessionIsValid(rec) {
  return Boolean(rec && rec.token && (rec.exp - config.TOKEN_EXPIRY_SKEW_SECONDS) > Math.floor(Date.now() / 1000));
}

// Returns the Copilot session used to build the Chathub WebSocket. Throws when the user must sign in.
function getSession(email) {
  const rec = sessions.get(String(email).toLowerCase());
  if (!rec) throw new NeedsLoginError('Not signed in');
  if (!sessionIsValid(rec)) throw new NeedsLoginError('Session expired — sign in again');
  return { token: rec.token, oid: rec.oid, tid: rec.tid, email: rec.email };
}

function getStatus(email) {
  const rec = sessions.get(String(email).toLowerCase());
  if (!rec) return { set: false, expired: false, expiresAt: null, email: null, name: null };
  return {
    set: true,
    expired: !sessionIsValid(rec),
    expiresAt: rec.exp ? new Date(rec.exp * 1000).toISOString() : null,
    email: rec.email,
    name: rec.name,
  };
}

function dropSession(email) {
  sessions.delete(String(email).toLowerCase());
  try { fs.unlinkSync(sessionFile(email)); } catch { /* already gone */ }
}

// ---------- mock login (COPILOT_MOCK=1) ----------

function mockToken(email) {
  const now = Math.floor(Date.now() / 1000);
  const b64u = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const claims = {
    oid: emailKey(email),
    tid: '00000000-0000-0000-0000-000000000000',
    exp: now + 3600,
    upn: email,
    email,
    name: String(email).split('@')[0],
  };
  return `${b64u({ alg: 'none', typ: 'JWT' })}.${b64u(claims)}.mock`;
}

function finishMock(flow) {
  const token = mockToken(flow.email);
  const rec = identityFromClaims(parseClaims(token), flow.email);
  saveSession({ ...rec, token, savedAt: new Date().toISOString() });
  flow.state = 'done';
  flow.email = rec.email;
  flow.name = rec.name;
  return flow;
}

function startMockLogin(email) {
  const flow = { id: crypto.randomUUID(), email, state: 'password', mock: true };
  flows.set(flow.id, flow);
  return flow;
}

function mockSubmitPassword(flow, password) {
  // In mock mode the password "mfa" exercises the two-step path.
  if (password === 'mfa') { flow.state = 'mfa'; return flow; }
  return finishMock(flow);
}

function mockSubmitMfa(flow, code) {
  if (String(code).trim() !== '123456') { flow.state = 'mfa'; flow.error = 'Wrong code — use 123456 in mock mode'; return flow; }
  return finishMock(flow);
}

// ---------- real login (Playwright) ----------

let pw = null;
function playwright() {
  if (!pw) pw = require('playwright');
  return pw;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, step = 300) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out');
    await sleep(step);
  }
}

async function waitForAny(fns, timeoutMs, step = 300) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const fn of fns) {
      if (await fn()) return fn;
    }
    if (Date.now() > deadline) return null;
    await sleep(step);
  }
}

// Page-state detectors. These target the standard Microsoft sign-in DOM; Copilot may change them.
const onCopilot = (page) => {
  const u = page.url();
  return u.includes('copilot.cloud.microsoft') && !u.includes('login.');
};

// Check for a VISIBLE element matching the selector. Hidden inputs must NOT count —
// Microsoft's login DOM keeps a hidden password field on the email page, which made the
// old count-based check wrongly conclude the password page had been reached.
const hasVisible = async (page, sel) => {
  const loc = page.locator(sel);
  const n = await loc.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    if (await loc.nth(i).isVisible().catch(() => false)) return true;
  }
  return false;
};
const hasEmailField = (page) => hasVisible(page, 'input[type="email"]');
const hasPasswordField = (page) => hasVisible(page, 'input[name="passwd"]');
const hasOtpField = (page) => hasVisible(page, 'input[name="otc"], input[id*="SAOTCC_OTC"], input[id*="TxtBx_SAOTCC"]');
const hasPasswordError = (page) => hasVisible(page, '#passwordError, [id*="passwordError"]');
const hasEmailError = (page) => hasVisible(page, '#usernameError, [id*="usernameError"]');

// A "Sign in" call-to-action means we are on the logged-out Copilot marketing page,
// not the signed-in chat. This is the key signal that sign-in has not happened yet.
const hasSignInCta = (page) => page.evaluate(() => {
  const els = Array.from(document.querySelectorAll('a, button'));
  return els.some((el) => /^\s*sign\s*in\s*$/i.test((el.textContent || '').trim()));
}).catch(() => false);

// "Stay signed in?" (KMSI) page.
const hasKmsi = (page) => page.evaluate(() => {
  const h = document.querySelector('h1, h2, [role="heading"]');
  return Boolean(h && /stay signed in/i.test(h.textContent || ''));
}).catch(() => false);

// The signed-in chat has a visible message composer.
const hasChatComposer = (page) => page.evaluate(() => {
  const els = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]'));
  return els.some((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
}).catch(() => false);

// True only when the real signed-in chat is showing (no marketing "Sign in" CTA, and a composer is present).
const isOnChat = async (page) => onCopilot(page) && !(await hasSignInCta(page)) && (await hasChatComposer(page));

async function clickSignIn(page) {
  return page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('a, button'));
    const el = els.find((e) => /^\s*sign\s*in\s*$/i.test((e.textContent || '').trim()));
    if (el) { el.click(); return true; }
    return false;
  }).catch(() => false);
}

async function clickYes(page) {
  return page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('input[type="submit"], button'));
    const el = els.find((e) => /^\s*yes\s*$/i.test((e.value || e.textContent || '').trim()));
    if (el) { el.click(); return true; }
    return false;
  }).catch(() => false);
}

async function submit(page) {
  const next = page.locator('#idSIButton9');
  if (await next.count()) { await next.first().click(); return; }
  const btn = page.locator('button[type="submit"]').first();
  if (await btn.count()) await btn.click();
  else await page.keyboard.press('Enter');
}

async function launchReal(email) {
  const chromium = playwright().chromium;
  const context = await chromium.launchPersistentContext(profileDir(email), {
    headless: config.HEADLESS,
    viewport: { width: 1280, height: 900 },
    userAgent: config.USER_AGENT,
    locale: 'en-US',
    args: ['--no-sandbox'],
  });
  const page = context.pages()[0] ?? await context.newPage();
  const flow = { id: crypto.randomUUID(), email, state: 'running', mock: false, context, page, wsUrl: null, reqUrl: null, idToken: null, round: 0 };
  flows.set(flow.id, flow);

  // The Chathub WebSocket URL carries the access_token we need.
  page.on('websocket', (ws) => {
    if (ws.url().includes(config.CHATHUB_WS_HOST) && !flow.wsUrl) flow.wsUrl = ws.url();
  });
  page.on('request', (req) => {
    const u = req.url();
    // Some builds pass access_token on a fetch/XHR URL instead of the WebSocket.
    if (!flow.reqUrl && /[?&]access_token=/.test(u)) flow.reqUrl = u;
    // The OAuth form_post to landingv2 carries the id_token, a fallback source of identity.
    if (u.includes('/landingv2') && req.method() === 'POST') {
      const m = (req.postData() ?? '').match(/id_token=([^&]+)/);
      if (m) flow.idToken = decodeURIComponent(m[1]);
    }
  });

  return flow;
}

async function settle(flow) {
  const page = flow.page;
  flow.round += 1;
  if (flow.round > 8) { flow.state = 'error'; flow.error = 'Could not determine the sign-in page'; return endFlow(flow); }

  if (await isOnChat(page)) {
    console.log('[auth] Signed-in chat detected — capturing token…');
    try { return await capture(flow); } catch (e) { flow.state = 'error'; flow.error = e.message; return endFlow(flow); }
  }
  if (await hasOtpField(page)) { flow.state = 'mfa'; console.log('[auth] Two-step verification required'); return flow; }
  if (await hasEmailField(page)) {
    const input = page.locator('input[type="email"]:visible').first();
    // Always overwrite: a stale remembered value in the profile surfaces as "invalid email".
    await input.fill(flow.email);
    console.log('[auth] Submitting email…');
    await submit(page);
    await waitForAny(
      [() => hasPasswordField(page), () => hasOtpField(page), () => hasEmailError(page), () => hasKmsi(page)],
      15000,
    );
    if (await hasEmailError(page)) {
      const errText = await page.evaluate(() => {
        const el = document.querySelector('#usernameError, [id*="usernameError"], [role="alert"]');
        return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
      }).catch(() => '');
      await page.screenshot({ path: path.join(__dirname, '..', 'tmp', 'emailerror.png') }).catch(() => {});
      console.log('[auth] Email error:', errText || '(none)');
      flow.state = 'error';
      flow.error = errText || 'Sign-in did not accept that email address';
      return endFlow(flow);
    }
    return settle(flow);
  }
  if (await hasPasswordField(page)) {
    await page.screenshot({ path: path.join(__dirname, '..', 'tmp', 'step_password.png') }).catch(() => {});
    flow.state = 'password';
    console.log('[auth] Password required');
    return flow;
  }
  if (await hasKmsi(page)) { console.log('[auth] "Stay signed in?" — choosing Yes'); await clickYes(page); await sleep(1500); return settle(flow); }
  // Logged-out Copilot marketing page — click "Sign in" to start Microsoft auth.
  if (onCopilot(page) && await hasSignInCta(page)) {
    console.log('[auth] On Copilot landing page — clicking "Sign in"');
    await clickSignIn(page);
    await sleep(2500);
    return settle(flow);
  }
  // Still loading — give the redirect a moment.
  if (flow.round < 7) { await sleep(2000); return settle(flow); }
  flow.state = 'error';
  flow.error = 'Unexpected sign-in page. Open the browser with COPILOT_HEADLESS=0 to inspect.';
  return endFlow(flow);
}

async function capture(flow) {
  const page = flow.page;
  // Wait for the SPA to open the Chathub WebSocket (or fetch a URL that carries the token).
  let tokenUrl = flow.wsUrl || flow.reqUrl;
  if (!tokenUrl) {
    try { tokenUrl = await waitFor(() => flow.wsUrl || flow.reqUrl, config.TOKEN_CAPTURE_TIMEOUT_MS); } catch { tokenUrl = null; }
  }
  if (tokenUrl) {
    try {
      const token = new URL(tokenUrl).searchParams.get('access_token');
      if (token) return finishReal(flow, token);
    } catch { /* malformed URL */ }
  }
  // Fallback: some builds stash the token in browser storage.
  const stored = await page.evaluate(() => {
    try {
      for (const store of [localStorage, sessionStorage]) {
        for (const key of Object.keys(store)) {
          if (/token|access|auth/i.test(key)) {
            const value = store.getItem(key);
            if (value && value.split('.').length === 3) return value;
          }
        }
      }
    } catch { /* ignore */ }
    return null;
  }).catch(() => null);
  if (stored) return finishReal(flow, stored);

  throw new LoginError('Signed in, but the Copilot chat token could not be captured automatically. Retry — the session is now remembered.');
}

function finishReal(flow, token) {
  const claims = parseClaims(token);
  const rec = identityFromClaims(claims, flow.email);
  saveSession({ ...rec, token, savedAt: new Date().toISOString() });
  flow.state = 'done';
  flow.email = rec.email;
  flow.name = rec.name;
  console.log(`[auth] Signed in as ${rec.email} — token captured (expires ${rec.exp ? new Date(rec.exp * 1000).toISOString() : 'unknown'})`);
  return endFlow(flow);
}

// Close the browser (flushing cookies to the persistent profile) and drop the flow.
function endFlow(flow) {
  flows.delete(flow.id);
  if (flow.context) { flow.context.close().catch(() => {}); flow.context = null; }
  return flow;
}

// ---------- public API ----------

async function startLogin(email) {
  email = String(email).trim().toLowerCase();
  if (config.MOCK) return startMockLogin(email);
  const flow = await launchReal(email);
  try {
    await flow.page.goto(config.LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: config.LOGIN_STEP_TIMEOUT_MS });
  } catch (e) {
    flow.state = 'error';
    flow.error = `Could not reach ${config.LOGIN_URL}: ${e.message}`;
    return endFlow(flow);
  }
  return settle(flow);
}

async function submitPassword(loginId, password) {
  const flow = flows.get(loginId);
  if (!flow) throw new LoginError('Login session not found — start again');
  if (flow.mock) return mockSubmitPassword(flow, password);
  const page = flow.page;
  try {
    await page.locator('input[name="passwd"]:visible').first().waitFor({ timeout: config.LOGIN_STEP_TIMEOUT_MS });
    await page.locator('input[name="passwd"]:visible').first().fill(String(password));
    console.log('[auth] Submitting password…');
    await submit(page);
    await waitForAny(
      [() => isOnChat(page), () => hasOtpField(page), () => hasKmsi(page), () => hasPasswordError(page), () => hasEmailError(page), () => hasEmailField(page), () => hasPasswordField(page)],
      config.LOGIN_STEP_TIMEOUT_MS,
    );
    if (await hasKmsi(page)) {
      console.log('[auth] "Stay signed in?" — choosing Yes');
      await clickYes(page);
      await waitForAny([() => isOnChat(page), () => hasOtpField(page)], config.LOGIN_STEP_TIMEOUT_MS);
    }
    if (await isOnChat(page)) {
      try { return await capture(flow); } catch (e) { flow.state = 'error'; flow.error = e.message; return endFlow(flow); }
    }
    if (await hasOtpField(page)) { flow.state = 'mfa'; console.log('[auth] Two-step verification required'); return flow; }
    if (await hasPasswordError(page) || await hasEmailError(page)) {
      const errText = await page.evaluate(() => {
        const el = document.querySelector('#passwordError, #usernameError, [id*="passwordError"], [id*="usernameError"], [role="alert"]');
        return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
      }).catch(() => '');
      await page.screenshot({ path: path.join(__dirname, '..', 'tmp', 'pwerror.png') }).catch(() => {});
      console.log('[auth] Microsoft error:', errText || '(none)');
      flow.state = 'password';
      flow.error = errText || 'Email or password was not accepted';
      return flow;
    }
    // Bounced back to the email page (e.g. stale remembered email) — refill and resubmit once.
    if (await hasEmailField(page)) {
      const input = page.locator('input[type="email"]:visible').first();
      await input.fill(flow.email);
      console.log('[auth] Back on email page — re-submitting email…');
      await submit(page);
      await sleep(2000);
      if (await hasPasswordField(page)) { flow.state = 'password'; return flow; }
    }
    flow.state = 'password';
    flow.error = 'Sign-in did not complete — try again';
    return flow;
  } catch (e) {
    flow.state = 'error';
    flow.error = e.message;
    return endFlow(flow);
  }
}

async function submitMfa(loginId, code) {
  const flow = flows.get(loginId);
  if (!flow) throw new LoginError('Login session not found — start again');
  if (flow.mock) return mockSubmitMfa(flow, code);
  const page = flow.page;
  try {
    const otp = page.locator('input[name="otc"]:visible, input[id*="SAOTCC_OTC"]:visible, input[id*="TxtBx_SAOTCC"]:visible').first();
    await otp.waitFor({ timeout: config.LOGIN_STEP_TIMEOUT_MS });
    await otp.fill(String(code).trim());
    console.log('[auth] Submitting verification code…');
    await submit(page);
    await sleep(1500);
    // "Stay signed in?" / KMSI may appear after a successful code.
    if (await page.locator('#idSIButton9').count()) { await page.locator('#idSIButton9').first().click(); }
    await waitForAny([() => isOnChat(page), () => hasOtpField(page), () => hasKmsi(page)], config.LOGIN_STEP_TIMEOUT_MS);
    if (await hasKmsi(page)) {
      await clickYes(page);
      await waitForAny([() => isOnChat(page), () => hasOtpField(page)], config.LOGIN_STEP_TIMEOUT_MS);
    }
    if (await isOnChat(page)) {
      try { return await capture(flow); } catch (e) { flow.state = 'error'; flow.error = e.message; return endFlow(flow); }
    }
    flow.state = 'mfa';
    flow.error = 'Code not accepted — check it and try again';
    return flow;
  } catch (e) {
    flow.state = 'error';
    flow.error = e.message;
    return endFlow(flow);
  }
}

function cancel(loginId) {
  const flow = flows.get(loginId);
  if (!flow) return;
  flows.delete(loginId);
  if (!flow.mock && flow.context) {
    flow.context.close().catch(() => {});
  }
}

// Best-effort browser teardown for any still-open flows (used on shutdown).
function dispose() {
  for (const flow of flows.values()) cancel(flow.id);
}

loadSessions();

module.exports = {
  NeedsLoginError,
  LoginError,
  startLogin,
  submitPassword,
  submitMfa,
  cancel,
  dispose,
  getSession,
  getStatus,
  dropSession,
};
