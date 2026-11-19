'use strict';

// Copilot chat-history operations over the _serverFn HTTP endpoint.
//
// Deleting a conversation does NOT go over the Chathub WebSocket that chat messages use. The
// browser calls a server function (serverFn) on copilot.cloud.microsoft with an x-route-id of
// "chat-history", authenticated with the copilot.cloud.microsoft session cookies (not the Chathub
// access_token). The body is TSS-framed (see ./tss.js). This module reproduces the
// DeleteConversation call captured from the browser.
//
// Caveat: the captured DeleteConversation request also carries the client's WHOLE chat-history
// state plus an IC3 sync watermark. This proxy does not maintain Copilot's history, so it sends a
// minimal state with the sync watermark captured at sign-in (or a freshly-built one). Whether the
// server accepts that minimal state is UNVERIFIED and must be smoke-tested against a real account.

const crypto = require('crypto');
const config = require('./config');
const { wrapData, decode } = require('./tss');

class HistoryError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'HistoryError';
    this.status = status;
  }
}

// IC3 sync watermark. Copilot's chat history syncs in timestamp "segments"; the client reports the
// ranges it has already delivered. A fresh watermark covering "now" is the best this proxy can offer
// when no capture from sign-in is available.
function makeSyncState(now = new Date()) {
  const stamp = now.toISOString().replace('Z', '+00:00');
  const inner = {
    deliveredSegments: [{ start: stamp, end: stamp }],
    zeroLMSTDeliveredSegments: [],
    sortOrder: 1,
    includeZeroLMST: false,
  };
  const outer = { IC3SyncState: Buffer.from(JSON.stringify(inner), 'utf8').toString('base64') };
  return Buffer.from(JSON.stringify(outer), 'utf8').toString('base64');
}

// Deep search of a decoded TSS object for the first non-empty syncState string. The sign-in capture
// stores it so the delete request can reuse the watermark Copilot actually handed to the browser.
function findSyncState(obj, seen = new Set()) {
  if (obj === null || typeof obj !== 'object' || seen.has(obj)) return null;
  seen.add(obj);
  if (typeof obj.syncState === 'string' && obj.syncState) return obj.syncState;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findSyncState(item, seen);
      if (found) return found;
    }
    return null;
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') {
      const found = findSyncState(value, seen);
      if (found) return found;
    }
  }
  return null;
}

function emptyHistoryList(syncState) {
  return {
    chats: [],
    syncState,
    hasRetentionPolicy: 3,
    errorMessage: '',
    metrics: {},
  };
}

function emptyTasks() {
  return {
    tasks: [],
    cursor: '',
    stats: { inProgress: 0, needsAttention: 0, completed: 0, failed: 0 },
    metrics: {},
  };
}

// Builds the TSS envelope for the DeleteConversation serverFn, matching the shape captured from the
// browser. `syncState` is the IC3 watermark; an empty string lets the server decide.
function buildDeleteBody({ conversationId, syncState = '' }) {
  const state = {
    conversationPageHistoryList: emptyHistoryList(syncState),
    chatLandingPageHistoryList: emptyHistoryList(syncState),
    chatLandingPageFilteredHistoryList: emptyHistoryList(syncState),
    pendingDeleteTasks: emptyTasks(),
    tasksHub: { tasks: [], cursor: '' },
    taskConversationPageHistoryList: emptyHistoryList(syncState),
  };
  const conversationHistoryFilter = emptyHistoryList('');
  return wrapData({ action: 'DeleteConversation', conversationId, state, conversationHistoryFilter });
}

function serverFnHeaders(session) {
  const headers = {
    accept: 'application/x-tss-framed, application/x-ndjson, application/json',
    'content-type': 'application/json',
    origin: config.ORIGIN,
    referer: `${config.ORIGIN}/chat`,
    'x-client-eligibility': session.clientEligibility || config.SERVERFN_CLIENT_ELIGIBILITY,
    'x-host-context': config.SERVERFN_HOST_CONTEXT,
    'x-route-id': 'chat-history',
    'x-session-id': session.serverFnSessionId || crypto.randomUUID(),
    'x-tsr-serverfn': 'true',
    'user-agent': config.USER_AGENT,
  };
  if (session.serverFnCookies) headers.cookie = session.serverFnCookies;
  return headers;
}

async function serverFnRequest(session, body) {
  const url = `${config.COPILOT_BASE_URL}/_serverFn/${config.SERVERFN_HASH}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: serverFnHeaders(session),
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new HistoryError(`Could not reach Copilot to delete the conversation: ${error.message}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new HistoryError(`Copilot rejected the session for delete (HTTP ${res.status}). Sign in again to re-capture cookies.`, res.status);
  }
  if (!res.ok) {
    throw new HistoryError(`Copilot refused to delete the conversation (HTTP ${res.status}).`, res.status);
  }
  // 200 = the delete was accepted. The body is the updated history state; we don't need it.
  return true;
}

// Deletes one conversation on Copilot's side. Returns true on success; throws HistoryError on
// failure. Requires a session with serverFnCookies captured at sign-in.
async function deleteConversation({ session, conversationId, syncState }) {
  if (!session.serverFnCookies) {
    throw new HistoryError('No Copilot web session cookies are stored for this account. Sign in again to capture them.', 403);
  }
  const watermark = syncState || session.chatSyncState || makeSyncState();
  const body = buildDeleteBody({ conversationId, syncState: watermark });
  return serverFnRequest(session, body);
}

module.exports = { deleteConversation, buildDeleteBody, makeSyncState, findSyncState, decode, HistoryError };
