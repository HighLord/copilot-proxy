'use strict';

const crypto = require('crypto');
const express = require('express');
const config = require('./config');
const { renderPrompt, createToolCallParser, estimateTokens } = require('./toolProtocol');

const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_INTERNAL_ERROR = 500;
const HTTP_BAD_GATEWAY = 502;
const RETRY_AFTER_SECONDS = 5;
const IMAGE_PLACEHOLDER = '[image omitted: this endpoint cannot pass images to Copilot]';

const MODELS = Object.freeze([
  { id: 'copilot', mode: 'quick', displayName: 'Copilot GPT-5.6 (quick response)' },
  { id: 'copilot-deep', mode: 'deep', displayName: 'Copilot GPT-5.6 (think)' },
]);
// Harnesses send whatever model name they were configured with (Claude Code even picks its own),
// so any name is accepted. Explicit aliases below map to a known Copilot mode; anything else
// containing a deep/think/reason token selects the slower reasoning mode.
const QUICK_MODEL_PATTERN = /(^copilot(-quick)?$)|(^gpt-5\.6(-quick|-chat)?$)|quick/i;
const DEEP_MODEL_PATTERN = /(^copilot-(deep|think|reasoning)$)|(^gpt-5\.6-(think|reasoning|deep)$)|deep|think|opus|reason/i;

function resolveModeId(model) {
  if (QUICK_MODEL_PATTERN.test(model)) return 'quick';
  if (DEEP_MODEL_PATTERN.test(model)) return 'deep';
  return 'quick';
}

class ApiError extends Error {
  constructor(status, type, message, extra = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.type = type;
    Object.assign(this, extra);
  }
}

const invalid = (message) => new ApiError(HTTP_BAD_REQUEST, 'invalid_request_error', message);

const newId = (prefix) => `${prefix}${crypto.randomBytes(12).toString('hex')}`;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Attachments are LocalFile annotations produced by POST /v1/files (or /api/upload). Accept either
// `{ id, name, url }` triples or the full annotation object; messageAnnotationType is pinned.
function normalizeAttachments(attachments) {
  return (Array.isArray(attachments) ? attachments.slice(0, 20) : [])
    .map((a) => ({
      id: String(a?.id ?? '').trim(),
      text: String(a?.name ?? a?.text ?? '').trim(),
      url: String(a?.url ?? '').trim(),
      messageAnnotationType: 'LocalFile',
    }))
    .filter((a) => a.id && a.text);
}

// ---------------------------------------------------------------------------
// Request normalisation: both dialects become one internal shape.
// ---------------------------------------------------------------------------

function textOfParts(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (!isObject(part)) return '';
    if (typeof part.text === 'string' && (part.type === undefined || part.type === 'text' || part.type === 'input_text' || part.type === 'output_text')) return part.text;
    if (part.type === 'image_url' || part.type === 'image' || part.type === 'input_image') return IMAGE_PLACEHOLDER;
    return '';
  }).filter(Boolean).join('\n');
}

function parseArguments(raw) {
  if (isObject(raw)) return raw;
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeOpenAiTools(body) {
  const list = Array.isArray(body.tools) ? body.tools : [];
  const tools = list
    .filter((tool) => isObject(tool) && tool.type === 'function' && isObject(tool.function) && typeof tool.function.name === 'string')
    .map((tool) => ({ name: tool.function.name, description: tool.function.description ?? '', parameters: tool.function.parameters ?? {} }));
  if (tools.length === 0 && Array.isArray(body.functions)) {
    for (const fn of body.functions) {
      if (isObject(fn) && typeof fn.name === 'string') tools.push({ name: fn.name, description: fn.description ?? '', parameters: fn.parameters ?? {} });
    }
  }
  return tools;
}

function normalizeOpenAiToolChoice(choice) {
  if (choice === 'none' || choice === 'required') return choice;
  if (isObject(choice) && choice.type === 'function' && typeof choice.function?.name === 'string') return { name: choice.function.name };
  return 'auto';
}

function normalizeOpenAi(body) {
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw invalid('messages must be a non-empty array');
  const system = [];
  const messages = [];
  const toolNames = new Map();
  for (const message of body.messages) {
    if (!isObject(message)) throw invalid('Each message must be an object');
    const text = textOfParts(message.content);
    if (message.role === 'system' || message.role === 'developer') {
      if (text) system.push(text);
    } else if (message.role === 'user') {
      messages.push({ role: 'user', text });
    } else if (message.role === 'assistant') {
      const toolCalls = [];
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        const id = String(call?.id ?? newId('call_'));
        const name = String(call?.function?.name ?? 'tool');
        toolNames.set(id, name);
        toolCalls.push({ id, name, arguments: parseArguments(call?.function?.arguments) });
      }
      if (isObject(message.function_call)) {
        toolCalls.push({ id: newId('call_'), name: String(message.function_call.name ?? 'tool'), arguments: parseArguments(message.function_call.arguments) });
      }
      messages.push({ role: 'assistant', text, toolCalls });
    } else if (message.role === 'tool' || message.role === 'function') {
      const id = String(message.tool_call_id ?? message.name ?? newId('call_'));
      messages.push({ role: 'tool', toolCallId: id, name: message.name ?? toolNames.get(id) ?? 'tool', text, isError: false });
    } else {
      throw invalid(`Unsupported message role "${message.role}"`);
    }
  }
  if (messages.length === 0) throw invalid('messages must contain at least one user message');
  const format = body.response_format?.type;
  return {
    system: system.join('\n\n'),
    messages,
    tools: normalizeOpenAiTools(body),
    toolChoice: normalizeOpenAiToolChoice(body.tool_choice ?? body.function_call),
    responseFormat: format === 'json_object' || format === 'json_schema' ? 'json' : null,
    singleCallOnly: body.parallel_tool_calls === false,
  };
}

function normalizeAnthropic(body) {
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw invalid('messages must be a non-empty array');
  const system = typeof body.system === 'string' ? body.system : textOfParts(body.system);
  const messages = [];
  const toolNames = new Map();
  for (const message of body.messages) {
    if (!isObject(message) || (message.role !== 'user' && message.role !== 'assistant')) {
      throw invalid('Each message needs a role of "user" or "assistant"');
    }
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : (Array.isArray(message.content) ? message.content : []);
    if (message.role === 'assistant') {
      const toolCalls = [];
      const texts = [];
      for (const block of blocks) {
        if (!isObject(block)) continue;
        if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
        else if (block.type === 'tool_use') {
          const id = String(block.id ?? newId('toolu_'));
          toolNames.set(id, String(block.name ?? 'tool'));
          toolCalls.push({ id, name: String(block.name ?? 'tool'), arguments: parseArguments(block.input) });
        }
      }
      messages.push({ role: 'assistant', text: texts.join('\n'), toolCalls });
    } else {
      const userTexts = [];
      for (const block of blocks) {
        if (!isObject(block)) continue;
        if (block.type === 'tool_result') {
          const id = String(block.tool_use_id ?? newId('toolu_'));
          messages.push({ role: 'tool', toolCallId: id, name: toolNames.get(id) ?? 'tool', text: textOfParts(block.content), isError: block.is_error === true });
        } else if (block.type === 'text' && typeof block.text === 'string') {
          userTexts.push(block.text);
        } else if (block.type === 'image' || block.type === 'document') {
          userTexts.push(IMAGE_PLACEHOLDER);
        }
      }
      if (userTexts.length > 0) messages.push({ role: 'user', text: userTexts.join('\n') });
    }
  }
  if (messages.length === 0) throw invalid('messages must contain some content');
  const tools = (Array.isArray(body.tools) ? body.tools : [])
    .filter((tool) => isObject(tool) && typeof tool.name === 'string' && isObject(tool.input_schema))
    .map((tool) => ({ name: tool.name, description: tool.description ?? '', parameters: tool.input_schema }));
  let toolChoice = 'auto';
  const choice = body.tool_choice;
  if (isObject(choice)) {
    if (choice.type === 'none') toolChoice = 'none';
    else if (choice.type === 'any') toolChoice = 'required';
    else if (choice.type === 'tool' && typeof choice.name === 'string') toolChoice = { name: choice.name };
  }
  return {
    system,
    messages,
    tools,
    toolChoice,
    responseFormat: null,
    singleCallOnly: choice?.disable_parallel_tool_use === true,
  };
}

// ---------------------------------------------------------------------------
// Response writers. Each sink has the same interface for both dialects and for streaming or not:
//   open() text(str) toolCall({id,name,arguments}) close(finish, usage) fail(error) ping()
// ---------------------------------------------------------------------------

const sseData = (res, data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
const sseEvent = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

function streamHeaders(res) {
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Tells nginx not to hold the stream back.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
}

function openAiUsage(usage) {
  return { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: usage.inputTokens + usage.outputTokens };
}

function openAiStreamSink(res, { model, stream_options: streamOptions }) {
  const id = newId('chatcmpl-');
  const created = Math.floor(Date.now() / 1000);
  let toolIndex = 0;
  const chunk = (delta, finishReason = null) => ({
    id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  return {
    open() {
      streamHeaders(res);
      sseData(res, chunk({ role: 'assistant', content: '' }));
    },
    text(text) { sseData(res, chunk({ content: text })); },
    // Copilot does not stream chain-of-thought, but it does emit progress/search status messages.
    // Surfaced here as reasoning_content (DeepSeek-style) so harnesses that show "thinking" do so.
    reasoning(text) { sseData(res, chunk({ reasoning_content: text })); },
    toolCall(call) {
      const index = toolIndex;
      toolIndex += 1;
      sseData(res, chunk({ tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } }] }));
      sseData(res, chunk({ tool_calls: [{ index, function: { arguments: JSON.stringify(call.arguments) } }] }));
    },
    close(finish, usage) {
      sseData(res, chunk({}, finish === 'tool_use' ? 'tool_calls' : 'stop'));
      if (streamOptions?.include_usage) sseData(res, { ...chunk({}), choices: [], usage: openAiUsage(usage) });
      res.write('data: [DONE]\n\n');
      res.end();
    },
    fail(error) {
      sseData(res, { error: { message: error.message, type: error.type, code: null, param: null } });
      res.write('data: [DONE]\n\n');
      res.end();
    },
    ping() { res.write(': ping\n\n'); },
  };
}

function openAiBufferSink(res, { model }) {
  const id = newId('chatcmpl-');
  let text = '';
  let reasoning = '';
  const calls = [];
  return {
    open() {},
    text(part) { text += part; },
    reasoning(part) { reasoning += part; },
    toolCall(call) { calls.push(call); },
    close(finish, usage) {
      const message = { role: 'assistant', content: text === '' && calls.length > 0 ? null : text };
      if (reasoning) message.reasoning_content = reasoning;
      if (calls.length > 0) {
        message.tool_calls = calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }));
      }
      res.json({
        id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, message, finish_reason: finish === 'tool_use' ? 'tool_calls' : 'stop' }],
        usage: openAiUsage(usage),
      });
    },
    fail() {},
    ping() {},
  };
}

function anthropicStreamSink(res, { model, inputTokens }) {
  const id = newId('msg_');
  let nextIndex = 0;
  let textIndex = null;
  let thinkingIndex = null;
  const closeText = () => {
    if (textIndex === null) return;
    sseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: textIndex });
    textIndex = null;
  };
  const closeThinking = () => {
    if (thinkingIndex === null) return;
    sseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: thinkingIndex });
    thinkingIndex = null;
  };
  return {
    open() {
      streamHeaders(res);
      sseEvent(res, 'message_start', {
        type: 'message_start',
        message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 1 } },
      });
    },
    text(text) {
      closeThinking();
      if (textIndex === null) {
        textIndex = nextIndex;
        nextIndex += 1;
        sseEvent(res, 'content_block_start', { type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } });
      }
      sseEvent(res, 'content_block_delta', { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text } });
    },
    reasoning(text) {
      if (thinkingIndex === null) {
        thinkingIndex = nextIndex;
        nextIndex += 1;
        sseEvent(res, 'content_block_start', { type: 'content_block_start', index: thinkingIndex, content_block: { type: 'thinking', thinking: '' } });
      }
      sseEvent(res, 'content_block_delta', { type: 'content_block_delta', index: thinkingIndex, delta: { type: 'thinking_delta', thinking: text } });
    },
    toolCall(call) {
      closeThinking();
      closeText();
      const index = nextIndex;
      nextIndex += 1;
      sseEvent(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } });
      sseEvent(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.arguments) } });
      sseEvent(res, 'content_block_stop', { type: 'content_block_stop', index });
    },
    close(finish, usage) {
      closeThinking();
      closeText();
      sseEvent(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: finish, stop_sequence: null }, usage: { output_tokens: usage.outputTokens } });
      sseEvent(res, 'message_stop', { type: 'message_stop' });
      res.end();
    },
    fail(error) {
      sseEvent(res, 'error', { type: 'error', error: { type: error.type, message: error.message } });
      res.end();
    },
    ping() { sseEvent(res, 'ping', { type: 'ping' }); },
  };
}

function anthropicBufferSink(res, { model }) {
  const id = newId('msg_');
  const content = [];
  let reasoning = '';
  return {
    open() {},
    text(text) {
      const last = content[content.length - 1];
      if (last?.type === 'text') last.text += text;
      else content.push({ type: 'text', text });
    },
    reasoning(text) { reasoning += text; },
    toolCall(call) { content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments }); },
    close(finish, usage) {
      if (reasoning) content.unshift({ type: 'thinking', thinking: reasoning });
      res.json({
        id, type: 'message', role: 'assistant', model, content, stop_reason: finish, stop_sequence: null,
        usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
      });
    },
    fail() {},
    ping() {},
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function toApiError(error) {
  if (error instanceof ApiError) return error;
  if (error?.type === 'entity.parse.failed') return invalid('Request body is not valid JSON');
  if (error?.type === 'entity.too.large') return new ApiError(HTTP_PAYLOAD_TOO_LARGE, 'invalid_request_error', 'Request body is too large');
  if (error?.needsLogin) {
    return new ApiError(HTTP_UNAUTHORIZED, 'authentication_error', `${error.message}. Sign in again in the web app, then retry; API keys keep working.`);
  }
  if (error?.name === 'CopilotError') {
    if (error.status === 401 || error.status === 403) {
      return new ApiError(HTTP_UNAUTHORIZED, 'authentication_error', `Copilot rejected the session: ${error.message}. Sign in again in the web app.`);
    }
    if (error.status === HTTP_TOO_MANY_REQUESTS) return new ApiError(HTTP_TOO_MANY_REQUESTS, 'rate_limit_error', error.message, { retryAfter: RETRY_AFTER_SECONDS });
    return new ApiError(error.status >= HTTP_INTERNAL_ERROR ? error.status : HTTP_BAD_GATEWAY, 'api_error', error.message);
  }
  return new ApiError(HTTP_INTERNAL_ERROR, 'api_error', 'Internal error');
}

const wantsAnthropicShape = (req) => req.path.startsWith('/messages') || Boolean(req.get('anthropic-version'));

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * deps: { streamChat, getSession, getAdmin, authenticate, mock }
 * Mount at /v1, before the app's own (small-limit) JSON parser.
 */
function createCompatRouter(deps) {
  const router = express.Router();
  const active = new Map();
  const disabledOptions = config.OPTIONS_SETS.filter((option) => config.API_DISABLED_OPTIONS_PATTERN.test(option));

  router.use((req, _res, next) => {
    const bearer = /^Bearer\s+(.+)$/i.exec(req.get('authorization') ?? '')?.[1];
    const presented = (req.get('x-api-key') || bearer || '').trim();
    const identity = presented ? deps.authenticate(presented) : null;
    if (!identity) {
      next(new ApiError(HTTP_UNAUTHORIZED, 'authentication_error', 'Invalid or missing API key. Create one on the API keys page of this server.'));
      return;
    }
    req.api = identity;
    next();
  });

  // After authentication, so an anonymous caller cannot make the server read a large body.
  router.use(express.json({ limit: config.API_JSON_BODY_LIMIT }));

  // Copilot's own sandbox, memory writer and web search are removed: the harness's tools are the only ones in play.
  function modeFor(modeId) {
    const admin = deps.getAdmin();
    const base = admin.modes[modeId] ?? admin.modes[admin.defaultMode];
    return {
      ...base,
      id: modeId,
      removeOptionsSets: [...new Set([...(base.removeOptionsSets ?? []), ...disabledOptions])],
      argOverrides: { ...(base.argOverrides ?? {}), plugins: [] },
    };
  }

  function acquire(email) {
    const count = active.get(email) ?? 0;
    if (count >= config.API_MAX_CONCURRENT_PER_USER) {
      throw new ApiError(HTTP_TOO_MANY_REQUESTS, 'rate_limit_error', 'Too many requests are running for this account. Wait for one to finish.', { retryAfter: RETRY_AFTER_SECONDS });
    }
    active.set(email, count + 1);
  }

  function release(email) {
    const count = (active.get(email) ?? 1) - 1;
    if (count <= 0) active.delete(email);
    else active.set(email, count);
  }

  async function handleChat(req, res, dialect) {
    const body = isObject(req.body) ? req.body : {};
    const canonical = dialect === 'anthropic' ? normalizeAnthropic(body) : normalizeOpenAi(body);
    const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : MODELS[0].id;
    const modeId = resolveModeId(model);
    const stream = body.stream === true;
    const started = Date.now();

    const { prompt, stats } = renderPrompt({ ...canonical, budget: config.API_MAX_PROMPT_CHARS });
    // Reported from what the harness sent, so its own context accounting stays meaningful.
    const requestChars = JSON.stringify(body.messages).length + JSON.stringify(body.system ?? '').length + JSON.stringify(body.tools ?? '').length;
    const usage = { inputTokens: estimateTokens(requestChars), outputTokens: 0 };

    // Checked before any bytes are sent, so a missing sign-in is a clean 401 rather than a broken stream.
    const session = deps.mock ? undefined : deps.getSession(req.api.email);
    acquire(req.api.email);

    const options = { model, stream_options: body.stream_options, inputTokens: usage.inputTokens };
    const makeSink = { openai: [openAiBufferSink, openAiStreamSink], anthropic: [anthropicBufferSink, anthropicStreamSink] }[dialect];
    const sink = makeSink[stream ? 1 : 0](res, options);

    const abort = new AbortController();
    res.on('close', () => { if (!res.writableFinished) abort.abort(); });
    let keepAlive = null;

    let outputChars = 0;
    let calls = 0;
    let outcome = 'ok';
    try {
      keepAlive = stream ? setInterval(() => sink.ping(), config.SSE_HEARTBEAT_MS) : null;
      const parser = createToolCallParser({
        toolNames: canonical.tools.map((tool) => tool.name),
        maxCalls: canonical.singleCallOnly ? 1 : Infinity,
      });
      const emit = (events) => {
        for (const event of events) {
          if (event.type === 'text') {
            outputChars += event.text.length;
            sink.text(event.text);
          } else {
            calls += 1;
            const call = { id: newId(dialect === 'anthropic' ? 'toolu_' : 'call_'), name: event.name, arguments: event.arguments };
            outputChars += JSON.stringify(call.arguments).length;
            sink.toolCall(call);
          }
        }
      };
      if (stream) sink.open();
      await deps.streamChat({
        session,
        prompt,
        conversationId: crypto.randomUUID(),
        mode: modeFor(modeId),
        messageAnnotations: normalizeAttachments(body.attachments),
        signal: abort.signal,
        onDelta: (delta) => emit(parser.push(delta)),
        onStatus: (status) => { if (status?.text) sink.reasoning(status.text); },
      });
      emit(parser.end());
      usage.outputTokens = estimateTokens(outputChars);
      sink.close(calls > 0 ? 'tool_use' : 'end_turn', usage);
    } catch (error) {
      outcome = abort.signal.aborted ? 'client_closed' : 'error';
      if (abort.signal.aborted) {
        res.end();
      } else if (stream && res.headersSent) {
        sink.fail(toApiError(error));
      } else {
        throw error;
      }
    } finally {
      if (keepAlive) clearInterval(keepAlive);
      release(req.api.email);
      // Metadata only: request bodies and keys are never logged.
      console.log(`[api] ${dialect} key="${req.api.label}" model=${model} mode=${modeId} stream=${stream} tools=${canonical.tools.length} `
        + `promptChars=${stats.chars} omittedMsgs=${stats.omittedMessages} toolDetail=${stats.toolDetailLevel} calls=${calls} `
        + `outcome=${outcome} ms=${Date.now() - started}`);
    }
  }

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

  router.post('/chat/completions', wrap((req, res) => handleChat(req, res, 'openai')));
  router.post('/messages', wrap((req, res) => handleChat(req, res, 'anthropic')));

  router.post('/messages/count_tokens', wrap(async (req, res) => {
    const body = isObject(req.body) ? req.body : {};
    normalizeAnthropic(body);
    const chars = JSON.stringify(body.messages).length + JSON.stringify(body.system ?? '').length + JSON.stringify(body.tools ?? '').length;
    res.json({ input_tokens: estimateTokens(chars) });
  }));

  // File upload for Copilot attachments. The body is the raw file bytes; the filename rides in the
  // query string (OpenAI's own endpoint uses multipart; this proxy accepts raw bytes instead). The
  // returned `id` is the LocalFile annotation id — pass it back via the `attachments` field of a
  // chat request to have Copilot read the file.
  router.post('/files', express.raw({ type: () => true, limit: config.MAX_UPLOAD_BYTES }), wrap(async (req, res) => {
    const name = String(req.query?.filename ?? req.query?.name ?? '').trim();
    if (!name) throw invalid('filename query parameter is required');
    if (!req.body || req.body.length === 0) throw invalid('Request body must be the file bytes');
    const purpose = String(req.query?.purpose ?? 'assistants');
    if (deps.mock || typeof deps.uploadFile !== 'function') {
      const annotation = { id: `SPO_mock_${crypto.randomUUID()}`, text: name, url: `https://example.com/${encodeURIComponent(name)}`, messageAnnotationType: 'LocalFile' };
      res.status(201).json({ id: annotation.id, object: 'file', filename: name, purpose, bytes: req.body.length, created_at: Math.floor(Date.now() / 1000) });
      return;
    }
    const session = deps.getSession(req.api.email);
    const result = await deps.uploadFile({
      session,
      name,
      data: req.body,
      mimeType: (req.get('content-type') || 'application/octet-stream').split(';')[0],
    });
    res.status(201).json({ id: result.annotation.id, object: 'file', filename: result.name, purpose, bytes: req.body.length, created_at: Math.floor(Date.now() / 1000) });
  }));

  const modelsFor = (req) => (wantsAnthropicShape(req)
    ? MODELS.map((model) => ({ type: 'model', id: model.id, display_name: model.displayName, created_at: '2025-01-01T00:00:00Z' }))
    : MODELS.map((model) => ({ id: model.id, object: 'model', created: 1735689600, owned_by: 'copilot-proxy' })));

  router.get('/models', (req, res) => {
    const data = modelsFor(req);
    if (wantsAnthropicShape(req)) res.json({ data, has_more: false, first_id: data[0].id, last_id: data[data.length - 1].id });
    else res.json({ object: 'list', data });
  });

  router.get('/models/:id', (req, res, next) => {
    const found = modelsFor(req).find((model) => model.id === req.params.id);
    if (!found) next(new ApiError(HTTP_NOT_FOUND, 'not_found_error', `The model "${req.params.id}" does not exist`));
    else res.json(found);
  });

  router.use((req, _res, next) => next(new ApiError(HTTP_NOT_FOUND, 'not_found_error', `Unknown endpoint ${req.method} /v1${req.path}`)));

  // eslint-disable-next-line no-unused-vars
  router.use((error, req, res, _next) => {
    const apiError = toApiError(error);
    if (error?.name === 'CopilotError') console.warn(`[api] Copilot error ${error.status}: ${error.message}`);
    else if (apiError.status >= HTTP_INTERNAL_ERROR && !(error instanceof ApiError)) console.error('[api] unexpected error:', error);
    if (res.headersSent) {
      res.end();
      return;
    }
    if (apiError.retryAfter) res.set('Retry-After', String(apiError.retryAfter));
    res.status(apiError.status).json(wantsAnthropicShape(req)
      ? { type: 'error', error: { type: apiError.type, message: apiError.message } }
      : { error: { message: apiError.message, type: apiError.type, code: null, param: null } });
  });

  return router;
}

module.exports = { createCompatRouter, normalizeOpenAi, normalizeAnthropic, MODELS };
