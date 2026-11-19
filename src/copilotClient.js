'use strict';

const { randomUUID } = require('crypto');
const WebSocket = require('ws');
const config = require('./config');
const { createDebugLog } = require('./debugLog');

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_BAD_GATEWAY = 502;
const HTTP_GATEWAY_TIMEOUT = 504;
const SUCCESS_RESULT = 'Success';
const CHAT_MESSAGE_TARGET = 'chat';
const UPDATE_TARGET = 'update';
const STATUS_MESSAGE_TYPES = new Set(['Progress', 'InternalSearchQuery', 'InternalLoaderMessage']);

class CopilotError extends Error {
  constructor(message, status = HTTP_BAD_GATEWAY) {
    super(message);
    this.name = 'CopilotError';
    this.status = status;
  }
}

function buildUrl({ session, conversationId, requestId, sessionId, urlParams = {} }) {
  const params = new URLSearchParams({
    chatsessionid: requestId,
    XRoutingParameterSessionKey: session.oid,
    clientrequestid: requestId,
    'X-SessionId': sessionId,
    ConversationId: conversationId,
    access_token: session.token,
  });
  if (config.VARIANTS) {
    params.set('variants', config.VARIANTS);
  }
  params.set('source', '"officeweb"');
  params.set('product', 'Office');
  params.set('agentHost', 'Bizchat.FullScreen');
  params.set('licenseType', 'Starter');
  params.set('isEdu', 'false');
  params.set('agent', 'web');
  params.set('scenario', 'OfficeWebIncludedCopilot');
  for (const [key, value] of Object.entries(urlParams)) {
    if (key !== 'access_token') params.set(key, String(value));
  }
  const url = `${config.CHATHUB_BASE_URL}/${session.oid}@${session.tid}?${params.toString()}`;

  // Same URL with identifiers and the token masked, safe to write to a debug log.
  const redacted = Object.fromEntries(params);
  redacted.access_token = '<redacted>';
  redacted.XRoutingParameterSessionKey = '<oid>';
  return { url, redacted: `${config.CHATHUB_BASE_URL}/<oid>@<tid>`, redactedParams: redacted };
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Recursively merges plain objects. Arrays and scalars in `source` replace the target value.
function mergeDeep(target, source) {
  for (const [key, value] of Object.entries(source ?? {})) {
    if (UNSAFE_KEYS.has(key)) continue;
    if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      mergeDeep(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

function buildOptionsSets(mode) {
  const removed = new Set(mode.removeOptionsSets ?? []);
  return [...new Set([...config.OPTIONS_SETS.filter((option) => !removed.has(option)), ...(mode.addOptionsSets ?? [])])];
}

function buildChatArguments({ prompt, requestId, sessionId, mode, messageAnnotations = [] }) {
  const clientInfo = { ...config.CLIENT_INFO, clientSessionId: sessionId };
  const args = {
    source: 'officeweb',
    clientCorrelationId: requestId,
    sessionId,
    optionsSets: buildOptionsSets(mode),
    streamingMode: 'ConciseWithPadding',
    options: {},
    extraExtensionParameters: {},
    allowedMessageTypes: config.ALLOWED_MESSAGE_TYPES,
    sliceIds: [],
    threadLevelGptId: {},
    requestId,
    traceId: requestId,
    isStartOfSession: false,
    clientInfo,
    message: {
      author: 'user',
      inputMethod: 'Keyboard',
      text: prompt,
      entityAnnotationTypes: config.ENTITY_ANNOTATION_TYPES,
      requestId,
      locationInfo: { timeZoneOffset: config.TIME_ZONE_OFFSET, timeZone: config.TIME_ZONE },
      locale: 'en-us',
      messageType: 'Chat',
      experienceType: 'Default',
      adaptiveCards: [],
      messageAnnotations: Array.isArray(messageAnnotations) ? messageAnnotations : [],
      clientPreferences: {},
      connectedFederatedConnections: ['dummyId'],
      clientInfo,
    },
    plugins: [{ Id: 'BingWebSearch', Source: 'BuiltIn' }],
    isSbsSupported: true,
    // The `tone` field is what actually selects the model mode on the wire (captured from the
    // browser): "Gpt_5_6_Chat" = quick response, "Gpt_5_6_Reasoning" = think. argOverrides can
    // still override it below (an admin escape hatch for a future/other model tone).
    tone: mode.tone || 'Magic',
    renderReferencesBehindEOS: true,
    disconnectBehavior: 'continue',
  };

  // Per-mode overrides come from the admin panel. They are applied last so a mode can change anything
  // captured from the browser, then the fields this proxy owns are pinned again.
  mergeDeep(args, mode.argOverrides);
  mergeDeep(args.message, mode.messageOverrides);
  args.message.text = prompt;
  args.message.requestId = requestId;
  args.requestId = requestId;
  return args;
}

function encodeFrame(payload) {
  return JSON.stringify(payload) + config.SIGNALR_RECORD_SEPARATOR;
}

/**
 * Sends one prompt and streams the reply.
 * Calls onDelta(text) for each chunk and resolves with the full reply text.
 * Opens one socket per turn, matching what the browser does.
 */
function streamChat({ session, prompt, conversationId, onDelta, onStatus, signal, mode = {}, messageAnnotations = [] }) {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID().replaceAll('-', '');
    const sessionId = randomUUID();
    const { url, redacted, redactedParams } = buildUrl({ session, conversationId, requestId, sessionId, urlParams: mode.urlParams });
    const debug = createDebugLog(`${mode.id ?? 'mode'}-${conversationId.slice(0, 8)}`);
    debug.log('connect', { url: redacted, params: redactedParams });
    const idleTimeoutMs = mode.timeoutMs ?? config.REQUEST_TIMEOUT_MS;

    const socket = new WebSocket(url, {
      headers: { Origin: config.ORIGIN, 'User-Agent': config.USER_AGENT },
    });

    let settled = false;
    let handshakeDone = false;
    let streamedText = '';
    let finalText = '';

    // Idle timeout: restarts whenever Copilot sends something other than a ping, so a long
    // "think deeper" run that keeps reporting progress is not cut off.
    let timeoutHandle;
    function armTimeout() {
      clearTimeout(timeoutHandle);
      timeoutHandle = setTimeout(
        () => fail(new CopilotError(`Timed out after ${Math.round(idleTimeoutMs / 1000)}s of silence from Copilot`, HTTP_GATEWAY_TIMEOUT)),
        idleTimeoutMs,
      );
    }
    armTimeout();

    function cleanup() {
      clearTimeout(timeoutHandle);
      debug.close();
      signal?.removeEventListener('abort', onAbort);
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      }
    }

    function fail(error) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }

    function succeed() {
      if (settled) return;
      settled = true;
      if (!streamedText && finalText) {
        // Reply arrived only in the final message; still deliver it to the caller.
        streamedText = finalText;
        onDelta(finalText);
      }
      cleanup();
      resolve(streamedText);
    }

    function onAbort() {
      fail(new CopilotError('Client disconnected', HTTP_BAD_GATEWAY));
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    function processUpdate(update) {
      if (typeof update.writeAtCursor === 'string') {
        streamedText += update.writeAtCursor;
        onDelta(update.writeAtCursor);
        return;
      }
      for (const message of update.messages ?? []) {
        // Chat replies carry no messageType; Progress, Suggestion, etc. do.
        const isBotChat = message.author === 'bot' && !message.messageType;
        if (!isBotChat && STATUS_MESSAGE_TYPES.has(message.messageType) && typeof message.text === 'string' && message.text) {
          onStatus?.({ kind: message.messageType, text: message.text });
          continue;
        }
        if (!isBotChat || typeof message.text !== 'string') continue;
        if (update.cursor) {
          // First chunk of a streamed reply.
          streamedText += message.text;
          onDelta(message.text);
        } else {
          finalText = message.text;
        }
      }
    }

    function handleFrame(frame) {
      switch (frame.type) {
        case undefined:
          // Handshake acknowledgement ({} or {"error": "..."}).
          if (frame.error) {
            fail(new CopilotError(`Handshake failed: ${frame.error}`));
            return;
          }
          if (handshakeDone) return;
          handshakeDone = true;
          socket.send(encodeFrame({ type: config.SIGNALR_TYPE_PING }));
          const invocation = {
            arguments: [buildChatArguments({ prompt, requestId, sessionId, mode, messageAnnotations })],
            invocationId: '0',
            target: CHAT_MESSAGE_TARGET,
            type: config.SIGNALR_TYPE_INVOCATION,
          };
          debug.log('out', invocation);
          socket.send(encodeFrame(invocation));
          return;
        case config.SIGNALR_TYPE_UPDATE:
          if (frame.target === UPDATE_TARGET) {
            for (const update of frame.arguments ?? []) processUpdate(update);
          }
          return;
        case config.SIGNALR_TYPE_COMPLETION: {
          const result = frame.item?.result;
          if (result && result.value !== SUCCESS_RESULT) {
            fail(new CopilotError(`Copilot returned ${result.value}: ${result.message ?? 'no detail'}`));
            return;
          }
          if (result?.message) finalText = result.message;
          succeed();
          return;
        }
        case config.SIGNALR_TYPE_STREAM_COMPLETION:
          succeed();
          return;
        case config.SIGNALR_TYPE_PING:
          socket.send(encodeFrame({ type: config.SIGNALR_TYPE_PING }));
          return;
        case config.SIGNALR_TYPE_CLOSE:
          fail(new CopilotError(`Copilot closed the connection: ${frame.error ?? 'no detail'}`));
          return;
        default:
      }
    }

    socket.on('open', () => {
      socket.send(encodeFrame({ protocol: 'json', version: 1 }));
    });

    socket.on('message', (data) => {
      for (const record of data.toString().split(config.SIGNALR_RECORD_SEPARATOR)) {
        if (!record) continue;
        let frame;
        try {
          frame = JSON.parse(record);
        } catch {
          debug.log('in-unparsed', record);
          continue; // Ignore malformed records rather than abort the whole reply.
        }
        debug.log('in', frame);
        if (frame.type !== config.SIGNALR_TYPE_PING) armTimeout();
        handleFrame(frame);
      }
    });

    socket.on('unexpected-response', (_request, response) => {
      const rejected = response.statusCode === HTTP_UNAUTHORIZED || response.statusCode === HTTP_FORBIDDEN;
      fail(
        new CopilotError(
          rejected
            ? `Copilot rejected the token (HTTP ${response.statusCode}). Capture a fresh one.`
            : `Copilot WebSocket upgrade failed (HTTP ${response.statusCode})`,
          rejected ? HTTP_UNAUTHORIZED : HTTP_BAD_GATEWAY,
        ),
      );
    });

    socket.on('error', (error) => {
      debug.log('socket-error', error.message);
      fail(new CopilotError(`WebSocket error: ${error.message}`));
    });
    socket.on('close', () => fail(new CopilotError('Connection closed before the reply completed')));
  });
}

module.exports = { streamChat, CopilotError, buildChatArguments };
