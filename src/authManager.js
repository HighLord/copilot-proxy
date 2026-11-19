'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { parseClaims, identityFromClaims } = require('./identity');
const { writeJsonAtomicSync, readJsonSync } = require('./fsUtil');

const AUTH_DIR = path.join(config.DATA_DIR, 'auth');
const SESSIONS_DIR = path.join(AUTH_DIR, 'sessions');
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

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

// lowercased email -> { oid, tid, exp, email, name, token, savedAt }
const sessions = new Map();
// loginId -> in-flight login flow
const flows = new Map();
// loginId -> flow that has ended (done or error). Kept briefly so a client polling for the outcome can
// still read it after the flow has been closed.
const finished = new Map();
const FINISHED_TTL_MS = 5 * 60_000;
const MOCK_STEP_DELAY_MS = 1500;

// Marks a flow as just used, so the idle reaper measures from the person's last action.
const touch = (flow) => { flow.lastActivity = Date.now(); };
// Browsers being started right now are not in `flows` yet; counting them stops simultaneous requests slipping past the cap.
let launching = 0;

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
  return {
    token: rec.token,
    oid: rec.oid,
    tid: rec.tid,
    email: rec.email,
    // Optional upload tokens (only present when captured at sign-in).
    refreshToken: rec.refreshToken ?? null,
    graphToken: rec.graphToken ?? null,
    graphTokenExp: rec.graphTokenExp ?? null,
    spoHost: rec.spoHost ?? null,
  };
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
  return endFlow(flow);
}

function startMockLogin(email) {
  const flow = { id: crypto.randomUUID(), email, state: 'password', mock: true, lastActivity: Date.now() };
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

// Screenshots can show an email address or a signed-in chat, so they are only taken when explicitly enabled.
async function debugScreenshot(page, name) {
  if (!config.DEBUG_SCREENSHOTS) return;
  try {
    const dir = path.join(__dirname, '..', 'tmp');
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, name) });
  } catch { /* a failed debug screenshot must never break sign-in */ }
}

async function submit(page) {
  const next = page.locator('#idSIButton9');
  if (await next.count()) { await next.first().click(); return; }
  const btn = page.locator('button[type="submit"]').first();
  if (await btn.count()) await btn.click();
  else await page.keyboard.press('Enter');
}

// Every sign-in gets its own throw-away browser with a fresh, non-persistent context (the equivalent
// of a private window). No cookies or remembered accounts survive between sign-ins, so one person's
// Microsoft session can never be picked up by the next person who signs in. The captured Copilot
// token is stored server-side in the session store, so nothing needs to persist in the browser.
async function launchReal(email) {
  const browser = await playwright().chromium.launch({ headless: config.HEADLESS, args: ['--no-sandbox'] });
  let context;
  let page;
  try {
    context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: config.USER_AGENT,
      locale: 'en-US',
    });
    page = await context.newPage();
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
  const flow = { id: crypto.randomUUID(), email, state: 'running', mock: false, browser, context, page, wsUrl: null, reqUrl: null, idToken: null, round: 0, lastActivity: Date.now() };
  flows.set(flow.id, flow);

  // The Chathub WebSocket URL carries the access_token we need.
  page.on('websocket', (ws) => {
    try { const u = new URL(ws.url()); console.log('[auth-debug] websocket:', u.host + u.pathname, 'has_access_token=' + u.searchParams.has('access_token')); } catch {}
    if (ws.url().includes(config.CHATHUB_WS_HOST) && /\/Chathub\//i.test(ws.url()) && /[?&]access_token=/.test(ws.url()) && !flow.wsUrl) flow.wsUrl = ws.url();
  });
  page.on('request', (req) => {
    try { const u = new URL(req.url()); if (u.searchParams.has('access_token')) console.log('[auth-debug] request with access_token:', u.host + u.pathname); } catch {}
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
    // Always overwrite: the field can arrive pre-filled, and a wrong pre-filled value surfaces as "invalid email".
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
      await debugScreenshot(page, 'emailerror.png');
      console.log('[auth] Email error:', errText || '(none)');
      flow.state = 'error';
      flow.error = errText || 'Sign-in did not accept that email address';
      return endFlow(flow);
    }
    return settle(flow);
  }
  if (await hasPasswordField(page)) {
    await debugScreenshot(page, 'step_password.png');
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

// Open the Chathub socket by sending a short message. Uses focus() instead of a mouse click,
// because an overlay on the page can intercept clicks and make them time out.
async function nudgeChat(flow) {
  const page = flow.page;
  await debugScreenshot(page, 'nudge.png');
  const info = await page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const desc = (el) => `${el.tagName.toLowerCase()} role=${el.getAttribute('role') || ''} aria="${el.getAttribute('aria-label') || ''}"`;
    return {
      url: location.href,
      boxes: Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')).filter(vis).map(desc),
      dialogs: Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')).filter(vis).map((el) => (el.innerText || '').replace(/\s+/g, ' ').slice(0, 120)),
    };
  }).catch(() => null);
  console.log('[auth-debug] chat page:', JSON.stringify(info));
  try {
    await page.keyboard.press('Escape'); // dismiss any popup in the way
    const focused = await page.evaluate(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const boxes = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')).filter(vis);
      boxes.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
      if (!boxes[0]) return false;
      boxes[0].focus();
      return true;
    });
    if (!focused) { console.log('[auth] No chat box found to send the trigger message'); return; }
    await page.keyboard.type('hi', { delay: 60 });
    await page.keyboard.press('Enter');
    console.log('[auth] Trigger message sent');
  } catch (e) { console.log('[auth] Could not send trigger message:', e.message); }
}

async function capture(flow) {
  const page = flow.page;
  // Wait for the SPA to open the Chathub WebSocket (or fetch a URL that carries the token).
  let tokenUrl = flow.wsUrl || flow.reqUrl;
  if (!tokenUrl) {
    try { tokenUrl = await waitFor(() => flow.wsUrl || flow.reqUrl, 15_000); } catch { tokenUrl = null; }
  }
  if (!tokenUrl) {
    // The Chathub socket may only open once a message is sent, so send a short one to trigger it.
    console.log('[auth] No Chathub socket yet — sending a message to open it');
    await nudgeChat(flow);
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
  // Best-effort: also grab the MSAL refresh token and a Files-scoped Graph token so file uploads
  // work later. These are additive — a failure here must never fail the sign-in itself.
  scanMsal(flow)
    .then((extras) => {
      if (!extras.refreshToken && !extras.graphToken) return;
      const current = sessions.get(rec.email);
      if (!current) return;
      const merged = { ...current };
      if (extras.refreshToken) merged.refreshToken = extras.refreshToken;
      if (extras.graphToken) { merged.graphToken = extras.graphToken; merged.graphTokenExp = extras.graphTokenExp ?? null; }
      if (extras.spoHost) merged.spoHost = extras.spoHost;
      saveSession(merged);
      console.log(`[auth] Captured upload tokens for ${rec.email} (refresh=${Boolean(extras.refreshToken)}, graph=${Boolean(extras.graphToken)})`);
    })
    .catch((error) => console.log(`[auth] Could not capture upload tokens: ${error.message}`));
  return endFlow(flow);
}

// Scans the browser's MSAL cache for a refresh token and a Files-scoped Graph/SharePoint access
// token. The Chathub chat token has no Files scope, so uploads need one of these.
async function scanMsal(flow) {
  const page = flow.page;
  if (!page) return {};
  const found = await page.evaluate(() => {
    const out = { refresh: null, jwts: [], spoHost: null };
    try {
      for (const store of [localStorage, sessionStorage]) {
        for (let i = 0; i < store.length; i += 1) {
          let key; let value;
          try { key = store.key(i); value = store.getItem(key); } catch { continue; }
          if (!key || !value) continue;
          if (!out.refresh && /refreshtoken/i.test(key)) out.refresh = value;
          if (value.split('.').length === 3 && value.length > 120) out.jwts.push(value);
          if (!out.spoHost) {
            const match = key.match(/([a-z0-9.-]+-my\.sharepoint\.com)/i);
            if (match) out.spoHost = match[1].toLowerCase();
          }
        }
      }
    } catch { /* storage access can throw on some pages */ }
    return out;
  }).catch(() => ({ refresh: null, jwts: [], spoHost: null }));

  const result = { refreshToken: found?.refresh ?? null, graphToken: null, graphTokenExp: null, spoHost: found?.spoHost ?? null };
  for (const jwt of found?.jwts ?? []) {
    try {
      const c = parseClaims(jwt);
      const scp = `${c.scp ?? ''} ${c.roles ?? ''}`.toLowerCase();
      const aud = String(c.aud ?? '').toLowerCase();
      const isFiles = /files\.readwrite|myfiles\.(read|write)|sites\.readwrite/i.test(scp);
      const isGraph = /graph\.microsoft\.com|sharepoint/i.test(aud);
      if (isFiles && (isGraph || scp.includes('files'))) {
        result.graphToken = jwt;
        result.graphTokenExp = c.exp ?? null;
        break;
      }
    } catch { /* not a decodable JWT */ }
  }
  return result;
}

// Closing the browser discards the private context along with every cookie it held.
function closeBrowser(flow) {
  const { browser } = flow;
  flow.browser = null;
  flow.context = null;
  if (browser) browser.close().catch(() => {});
}

// Close the browser and drop the flow.
function endFlow(flow) {
  flows.delete(flow.id);
  closeBrowser(flow);
  finished.set(flow.id, flow);
  setTimeout(() => finished.delete(flow.id), FINISHED_TTL_MS).unref();
  return flow;
}

// ---------- public API ----------

// Opens the private browser for an email. Quick (a second or two); throws LoginError if it cannot start.
async function openFlow(email) {
  // Close any earlier browser still open for this email so abandoned attempts do not pile up.
  for (const f of [...flows.values()]) {
    if (!f.mock && f.email === email) {
      flows.delete(f.id);
      closeBrowser(f);
    }
  }
  // Each sign-in is a whole Chromium, so a small server can only hold a few at once.
  if (flows.size + launching >= config.MAX_CONCURRENT_LOGINS) {
    throw new LoginError('Too many sign-ins are in progress. Please try again in a few minutes.');
  }
  let flow;
  launching += 1;
  try {
    flow = await launchReal(email);
  } catch (error) {
    // Surface the real reason (for example Chromium not installed) instead of a generic server error.
    throw new LoginError(`Could not start the sign-in browser: ${error.message.split('\n')[0]}`);
  } finally {
    launching -= 1;
  }
  return flow;
}

// The slow part: load the Microsoft page and work out which step it is on.
async function navigateAndSettle(flow) {
  try {
    await flow.page.goto(config.LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: config.LOGIN_STEP_TIMEOUT_MS });
  } catch (e) {
    flow.state = 'error';
    flow.error = `Could not reach ${config.LOGIN_URL}: ${e.message}`;
    return endFlow(flow);
  }
  return settle(flow);
}

async function startLogin(email) {
  email = String(email).trim().toLowerCase();
  if (config.MOCK) return startMockLogin(email);
  return navigateAndSettle(await openFlow(email));
}

// ---------- background variants ----------
// These return straight away with state "working" and keep going on the server. The client polls
// getFlowState() until the state changes. No HTTP request has to stay open while Microsoft is slow,
// which is what made phones show "Load failed".

function runInBackground(flow, task) {
  touch(flow);
  flow.busy = true;
  flow.state = 'working';
  flow.error = undefined;
  Promise.resolve()
    .then(task)
    .catch((error) => {
      flow.state = 'error';
      flow.error = error.message;
      endFlow(flow);
    })
    .finally(() => {
      flow.busy = false;
      touch(flow);
      if (flow.state === 'working') { flow.state = 'error'; flow.error = 'Sign-in did not finish'; endFlow(flow); }
    });
  return flow;
}

function getOpenFlow(loginId) {
  const flow = flows.get(loginId);
  if (!flow) {
    // An attempt closed for being idle keeps its reason for a few minutes; show that instead of a generic message.
    throw new LoginError(finished.get(loginId)?.error ?? 'Login session not found — start again');
  }
  if (flow.busy) throw new LoginError('Still working on the previous step');
  return flow;
}

async function startLoginBackground(email) {
  email = String(email).trim().toLowerCase();
  if (config.MOCK) {
    const flow = startMockLogin(email);
    return runInBackground(flow, async () => { await sleep(MOCK_STEP_DELAY_MS); flow.state = 'password'; });
  }
  const flow = await openFlow(email);
  return runInBackground(flow, () => navigateAndSettle(flow));
}

function submitPasswordBackground(loginId, password) {
  const flow = getOpenFlow(loginId);
  if (flow.mock) return runInBackground(flow, async () => { await sleep(MOCK_STEP_DELAY_MS); mockSubmitPassword(flow, password); });
  return runInBackground(flow, () => submitPassword(loginId, password));
}

function submitMfaBackground(loginId, code) {
  const flow = getOpenFlow(loginId);
  if (flow.mock) return runInBackground(flow, async () => { await sleep(MOCK_STEP_DELAY_MS); mockSubmitMfa(flow, code); });
  return runInBackground(flow, () => submitMfa(loginId, code));
}

// Current state of a flow, whether it is still open or has just ended. null if unknown or expired.
function getFlowState(loginId) {
  return flows.get(loginId) ?? finished.get(loginId) ?? null;
}

async function submitPassword(loginId, password) {
  const flow = flows.get(loginId);
  if (!flow) throw new LoginError('Login session not found — start again');
  touch(flow);
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
      await debugScreenshot(page, 'pwerror.png');
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
  touch(flow);
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
  if (!flow.mock) closeBrowser(flow);
}

// Closes sign-in attempts that were started but then abandoned (tab closed, phone locked, person walked away).
// A flow that is busy with a step is never touched: that step has its own timeouts and ends the flow itself.
function reapIdleFlows() {
  const cutoff = Date.now() - config.LOGIN_IDLE_TIMEOUT_MS;
  for (const flow of [...flows.values()]) {
    if (flow.busy || flow.lastActivity > cutoff) continue;
    console.log(`[auth] Closing idle sign-in for ${flow.email} (no activity for ${Math.round(config.LOGIN_IDLE_TIMEOUT_MS / 60_000)} min)`);
    flow.state = 'error';
    flow.error = 'Sign-in timed out — start again';
    endFlow(flow);
  }
}

// Best-effort browser teardown for any still-open flows (used on shutdown).
function dispose() {
  for (const flow of flows.values()) cancel(flow.id);
}

loadSessions();
// unref() so this timer alone never keeps the process alive during shutdown.
setInterval(reapIdleFlows, config.LOGIN_IDLE_CHECK_INTERVAL_MS).unref();

module.exports = {
  NeedsLoginError,
  LoginError,
  startLogin,
  submitPassword,
  submitMfa,
  startLoginBackground,
  submitPasswordBackground,
  submitMfaBackground,
  getFlowState,
  cancel,
  dispose,
  getSession,
  getStatus,
  dropSession,
};
