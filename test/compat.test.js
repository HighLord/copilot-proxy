'use strict';

// Run with: node --test test/compat.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-test-'));

const express = require('express');
const config = require('../src/config');
const { defaultAdminSettings } = require('../src/defaults');
const { createToolCallParser, renderPrompt } = require('../src/toolProtocol');
const apiKeys = require('../src/apiKeys');
const { createCompatRouter } = require('../src/compatApi');
const { decodeDriveId, buildFileAnnotation } = require('../src/upload');
const { buildChatArguments } = require('../src/copilotClient');

// ---------------------------------------------------------------- parser

function parseAll(chunks, options) {
  const parser = createToolCallParser(options);
  const events = chunks.flatMap((chunk) => parser.push(chunk));
  events.push(...parser.end());
  // Merge adjacent text events so different chunkings compare equal.
  const merged = [];
  for (const event of events) {
    const last = merged[merged.length - 1];
    if (event.type === 'text' && last?.type === 'text') last.text += event.text;
    else merged.push({ ...event });
  }
  return merged;
}

const NAMES = ['read_file', 'bash'];
const SAMPLES = [
  'Just a plain answer with `code` and a ```python\nprint(1)\n``` fence.',
  'Let me look.\n<tool_call>{"name": "read_file", "arguments": {"path": "/a/b.txt"}}</tool_call>',
  '<tool_call>{"name":"bash","arguments":{"command":"echo \\"hi\\" && ls"}}</tool_call><tool_call>{"name":"read_file","arguments":{"path":"x"}}</tool_call>',
  'Reading it.\n```tool_call\n{"name": "read_file", "arguments": {"path": "x"}}\n```\n',
  '<tool_call>\n```json\n{"name": "bash", "arguments": {"command": "pwd",}}\n```\n</tool_call>',
  'A less-than sign < and a tag-like <tool and <b>bold</b> text.',
];

test('parser: result is identical for every way of splitting the text into chunks', () => {
  for (const sample of SAMPLES) {
    const whole = parseAll([sample], { toolNames: NAMES });
    for (let i = 1; i < sample.length; i += 1) {
      assert.deepEqual(parseAll([sample.slice(0, i), sample.slice(i)], { toolNames: NAMES }), whole, `split at ${i} of ${JSON.stringify(sample)}`);
    }
    const singles = parseAll([...sample], { toolNames: NAMES });
    assert.deepEqual(singles, whole, 'one character at a time');
  }
});

test('parser: plain text passes through untouched, including fences and angle brackets', () => {
  const events = parseAll([SAMPLES[0]], { toolNames: NAMES });
  assert.deepEqual(events, [{ type: 'text', text: SAMPLES[0] }]);
  const angle = parseAll([SAMPLES[5]], { toolNames: NAMES });
  assert.deepEqual(angle, [{ type: 'text', text: SAMPLES[5] }]);
});

test('parser: tag, fence, multiple calls, lenient JSON', () => {
  assert.deepEqual(parseAll([SAMPLES[1]], { toolNames: NAMES }), [
    { type: 'text', text: 'Let me look.\n' },
    { type: 'tool_call', name: 'read_file', arguments: { path: '/a/b.txt' } },
  ]);
  const multi = parseAll([SAMPLES[2]], { toolNames: NAMES });
  assert.deepEqual(multi.map((e) => e.name), ['bash', 'read_file']);
  assert.equal(multi[0].arguments.command, 'echo "hi" && ls');
  assert.deepEqual(parseAll([SAMPLES[3]], { toolNames: NAMES })[1], { type: 'tool_call', name: 'read_file', arguments: { path: 'x' } });
  assert.deepEqual(parseAll([SAMPLES[4]], { toolNames: NAMES }), [{ type: 'tool_call', name: 'bash', arguments: { command: 'pwd' } }]);
});

test('parser: accepts alternative field names and string arguments', () => {
  const a = parseAll(['<tool_call>{"tool":"bash","input":{"command":"ls"}}</tool_call>'], { toolNames: NAMES });
  assert.deepEqual(a, [{ type: 'tool_call', name: 'bash', arguments: { command: 'ls' } }]);
  const b = parseAll(['<tool_call>{"function":{"name":"BASH","arguments":"{\\"command\\":\\"ls\\"}"}}</tool_call>'], { toolNames: NAMES });
  assert.deepEqual(b, [{ type: 'tool_call', name: 'bash', arguments: { command: 'ls' } }]);
  const c = parseAll(['<tool_call>[{"name":"bash","arguments":{}},{"name":"read_file","arguments":{"path":"p"}}]</tool_call>'], { toolNames: NAMES });
  assert.equal(c.length, 2);
});

test('parser: unknown tool or broken JSON is shown as text, never silently dropped', () => {
  const unknown = parseAll(['<tool_call>{"name":"rm_rf","arguments":{}}</tool_call>'], { toolNames: NAMES });
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].type, 'text');
  assert.match(unknown[0].text, /rm_rf/);
  const broken = parseAll(['<tool_call>{"name": "bash", "arguments": {</tool_call>'], { toolNames: NAMES });
  assert.equal(broken[0].type, 'text');
});

test('parser: prose after a call is discarded; maxCalls is honoured', () => {
  const events = parseAll(['<tool_call>{"name":"bash","arguments":{}}</tool_call>\nTool result: invented output'], { toolNames: NAMES });
  assert.deepEqual(events.map((e) => e.type), ['tool_call']);
  const capped = parseAll([SAMPLES[2]], { toolNames: NAMES, maxCalls: 1 });
  assert.equal(capped.filter((e) => e.type === 'tool_call').length, 1);
});

test('parser: a call whose closing tag never arrives is still recovered; a dangling opener is flushed', () => {
  const recovered = parseAll(['<tool_call>{"name":"bash","arguments":{"command":"ls"}}'], { toolNames: NAMES });
  assert.deepEqual(recovered, [{ type: 'tool_call', name: 'bash', arguments: { command: 'ls' } }]);
  const dangling = parseAll(['Ends with <tool'], { toolNames: NAMES });
  assert.deepEqual(dangling, [{ type: 'text', text: 'Ends with <tool' }]);
});

// ---------------------------------------------------------------- prompt

const bigTool = (n) => ({
  name: `tool_${n}`,
  description: `Does thing number ${n}. ${'It has a very long explanation. '.repeat(40)}`,
  parameters: {
    type: 'object',
    required: ['a'],
    properties: {
      a: { type: 'string', description: 'x'.repeat(300) },
      b: { type: 'array', items: { type: 'object', properties: { c: { type: 'string' }, d: { enum: ['x', 'y'] } } } },
    },
  },
});

test('prompt: never exceeds the budget, whatever the harness sends', () => {
  const budgets = [2_000, 4_000, 8_000, 30_000];
  for (const budget of budgets) {
    for (const toolCount of [0, 3, 25, 80]) {
      const messages = [{ role: 'user', text: 'Original task. '.repeat(500) }];
      for (let i = 0; i < 40; i += 1) {
        messages.push({ role: 'assistant', text: 'thinking '.repeat(300), toolCalls: [{ id: `c${i}`, name: 'tool_1', arguments: { big: 'z'.repeat(5_000) } }] });
        messages.push({ role: 'tool', toolCallId: `c${i}`, name: 'tool_1', text: 'out '.repeat(3_000), isError: false });
      }
      messages.push({ role: 'user', text: 'LATEST QUESTION '.repeat(2_000) });
      const { prompt } = renderPrompt({
        system: 'You are a coding agent. '.repeat(2_000),
        messages,
        tools: Array.from({ length: toolCount }, (_, n) => bigTool(n)),
        budget,
      });
      assert.ok(prompt.length <= budget, `budget ${budget}, tools ${toolCount}: got ${prompt.length}`);
      assert.match(prompt, /LATEST QUESTION/);
    }
  }
});

test('prompt: tells Copilot its own sandbox is off and the harness tools are the way to act', () => {
  const { prompt } = renderPrompt({
    messages: [{ role: 'user', text: 'hi' }],
    tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
    budget: 8_000,
  });
  assert.match(prompt, /code interpreter/);
  assert.match(prompt, /\/mnt\/data/);
  assert.match(prompt, /<tool_call>/);
  assert.match(prompt, /read_file\(path: string\)/);
});

test('prompt: keeps the opening task and the newest turns, marks what was left out', () => {
  const messages = [{ role: 'user', text: 'FIRST TASK' }];
  for (let i = 0; i < 30; i += 1) messages.push({ role: i % 2 ? 'user' : 'assistant', text: `middle ${i} ${'pad '.repeat(200)}` });
  messages.push({ role: 'user', text: 'NEWEST' });
  const { prompt, stats } = renderPrompt({ messages, budget: 3_000 });
  assert.match(prompt, /FIRST TASK/);
  assert.match(prompt, /NEWEST/);
  assert.match(prompt, /earlier messages? omitted/);
  assert.ok(stats.omittedMessages > 0);
});

test('prompt: a larger budget really allows longer messages (caps scale with it)', () => {
  const long = 'L'.repeat(20_000);
  const small = renderPrompt({ messages: [{ role: 'user', text: long }], budget: 8_000 }).prompt;
  const large = renderPrompt({ messages: [{ role: 'user', text: long }], budget: 40_000 }).prompt;
  assert.ok(small.length <= 8_000);
  assert.ok(large.length > 20_000 && large.length <= 40_000, `got ${large.length}`);
});

test('prompt: tool_choice none hides tools; required and named are stated', () => {
  const tools = [{ name: 'bash', description: 'Run', parameters: {} }];
  const none = renderPrompt({ messages: [{ role: 'user', text: 'x' }], tools, toolChoice: 'none', budget: 8_000 }).prompt;
  assert.doesNotMatch(none, /TOOLS AVAILABLE/);
  assert.match(none, /Do not call any tools/);
  assert.match(renderPrompt({ messages: [{ role: 'user', text: 'x' }], tools, toolChoice: 'required', budget: 8_000 }).prompt, /MUST call at least one tool/);
  assert.match(renderPrompt({ messages: [{ role: 'user', text: 'x' }], tools, toolChoice: { name: 'bash' }, budget: 8_000 }).prompt, /MUST call the tool "bash"/);
});

// ---------------------------------------------------------------- key store

test('keys: created once, stored hashed, authenticate, limit, revoke', () => {
  const created = apiKeys.createKey('A@x.com', 'laptop');
  assert.match(created.key, /^cpk_/);
  assert.equal(created.key.length > 30, true);
  const onDisk = fs.readFileSync(path.join(process.env.DATA_DIR, 'auth', 'apikeys.json'), 'utf8');
  assert.ok(!onDisk.includes(created.key), 'plain key must not be stored');
  assert.deepEqual(apiKeys.authenticate(created.key).email, 'a@x.com');
  assert.equal(apiKeys.authenticate(`${created.key}x`), null);
  assert.equal(apiKeys.authenticate('cpk_nope'), null);
  assert.equal(apiKeys.authenticate('not-a-key'), null);
  assert.equal(apiKeys.listKeys('a@x.com').length, 1);
  assert.equal(apiKeys.listKeys('b@x.com').length, 0);
  assert.equal(apiKeys.revokeKey('b@x.com', created.id), false, 'another user cannot revoke it');
  assert.equal(apiKeys.revokeKey('a@x.com', created.id), true);
  assert.equal(apiKeys.authenticate(created.key), null);
  for (let i = 0; i < config.API_MAX_KEYS_PER_USER; i += 1) apiKeys.createKey('c@x.com', `k${i}`);
  assert.throws(() => apiKeys.createKey('c@x.com', 'one too many'), /at most/);
});

// ---------------------------------------------------------------- HTTP

class FakeCopilotError extends Error {
  constructor(message, status) { super(message); this.name = 'CopilotError'; this.status = status; }
}

async function startServer(script) {
  const calls = [];
  const state = { slow: false };
  const streamChat = async (args) => {
    calls.push(args);
    if (state.slow) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 400);
        args.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); });
      });
    }
    await script(args, calls.length);
  };
  const app = express();
  app.use('/v1', createCompatRouter({
    streamChat,
    getSession: () => ({ token: 't' }),
    getAdmin: () => defaultAdminSettings(),
    authenticate: apiKeys.authenticate,
    mock: false,
  }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const { key } = apiKeys.createKey(`http-${Math.random()}@x.com`, 'test');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
  const post = (url, body, extra = {}) => fetch(`${base}${url}`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  return { server, base, calls, state, headers, key, post, close: () => server.close() };
}

const sse = (text) => text.split('\n\n').filter((block) => block.trim() && !block.startsWith(':')).map((block) => {
  const lines = block.split('\n');
  const event = lines.find((l) => l.startsWith('event: '))?.slice(7);
  const data = lines.find((l) => l.startsWith('data: '))?.slice(6);
  return { event, data: data === '[DONE]' ? '[DONE]' : JSON.parse(data) };
});

const TOOLS_OPENAI = [{ type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }];
const CALL_TEXT = ['Checking. <tool_', 'call>{"name":"read_file","argu', 'ments":{"path":"/etc/hosts"}}</tool_ca', 'll>'];
const feed = (chunks) => async ({ onDelta }) => { for (const chunk of chunks) onDelta(chunk); };

test('http: authentication', async () => {
  const t = await startServer(feed(['hi']));
  try {
    const none = await fetch(`${t.base}/v1/models`);
    assert.equal(none.status, 401);
    assert.equal((await none.json()).error.type, 'authentication_error');
    const bad = await fetch(`${t.base}/v1/models`, { headers: { Authorization: 'Bearer cpk_wrong' } });
    assert.equal(bad.status, 401);
    const viaHeader = await fetch(`${t.base}/v1/models`, { headers: { 'x-api-key': t.key } });
    assert.equal(viaHeader.status, 200);
    const anthropicError = await fetch(`${t.base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(anthropicError.status, 401);
    assert.equal((await anthropicError.json()).type, 'error');
  } finally { t.close(); }
});

test('http: models in both shapes', async () => {
  const t = await startServer(feed(['hi']));
  try {
    const openai = await (await fetch(`${t.base}/v1/models`, { headers: t.headers })).json();
    assert.equal(openai.object, 'list');
    assert.deepEqual(openai.data.map((m) => m.id), ['copilot', 'copilot-deep']);
    const anthropic = await (await fetch(`${t.base}/v1/models`, { headers: { ...t.headers, 'anthropic-version': '2023-06-01' } })).json();
    assert.equal(anthropic.data[0].type, 'model');
    assert.equal(anthropic.has_more, false);
  } finally { t.close(); }
});

test('http openai: plain answer, non-streaming and streaming', async () => {
  const t = await startServer(feed(['Hel', 'lo ', 'world']));
  try {
    const plain = await (await t.post('/v1/chat/completions', { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] })).json();
    assert.equal(plain.object, 'chat.completion');
    assert.equal(plain.choices[0].message.content, 'Hello world');
    assert.equal(plain.choices[0].finish_reason, 'stop');
    assert.ok(plain.usage.total_tokens > 0);

    const res = await t.post('/v1/chat/completions', { model: 'x', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'hi' }] });
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const events = sse(await res.text());
    assert.equal(events.at(-1).data, '[DONE]');
    assert.equal(events[0].data.choices[0].delta.role, 'assistant');
    const text = events.map((e) => e.data?.choices?.[0]?.delta?.content ?? '').join('');
    assert.equal(text, 'Hello world');
    assert.equal(events.at(-3).data.choices[0].finish_reason, 'stop');
    assert.ok(events.at(-2).data.usage);
  } finally { t.close(); }
});

test('http openai: tool call round trip, non-streaming and streaming', async () => {
  const t = await startServer(feed(CALL_TEXT));
  try {
    const body = { model: 'm', messages: [{ role: 'user', content: 'read hosts' }], tools: TOOLS_OPENAI };
    const first = await (await t.post('/v1/chat/completions', body)).json();
    const choice = first.choices[0];
    assert.equal(choice.finish_reason, 'tool_calls');
    assert.equal(choice.message.content, 'Checking. ');
    const call = choice.message.tool_calls[0];
    assert.match(call.id, /^call_/);
    assert.equal(call.function.name, 'read_file');
    assert.deepEqual(JSON.parse(call.function.arguments), { path: '/etc/hosts' });

    const events = sse(await (await t.post('/v1/chat/completions', { ...body, stream: true })).text());
    const deltas = events.filter((e) => e.data !== '[DONE]').map((e) => e.data.choices[0]);
    const toolDeltas = deltas.flatMap((c) => c.delta.tool_calls ?? []);
    assert.equal(toolDeltas[0].function.name, 'read_file');
    assert.equal(toolDeltas[0].function.arguments, '');
    assert.deepEqual(JSON.parse(toolDeltas[1].function.arguments), { path: '/etc/hosts' });
    assert.equal(deltas.at(-1).finish_reason, 'tool_calls');
    assert.equal(deltas.map((c) => c.delta.content ?? '').join(''), 'Checking. ');

    // The follow-up turn carries the call and its result; both must reach Copilot as context.
    const followUp = { ...body, messages: [...body.messages,
      { role: 'assistant', content: null, tool_calls: [call] },
      { role: 'tool', tool_call_id: call.id, content: 'HOSTS FILE CONTENT' }] };
    await t.post('/v1/chat/completions', followUp);
    const sent = t.calls.at(-1).prompt;
    assert.match(sent, /Assistant called read_file/);
    assert.match(sent, /Tool result from read_file/);
    assert.match(sent, /HOSTS FILE CONTENT/);
  } finally { t.close(); }
});

test('http: Copilot is called with its sandbox, memory and web search removed, and a fresh conversation each time', async () => {
  const t = await startServer(feed(['ok']));
  try {
    await t.post('/v1/chat/completions', { model: 'copilot', messages: [{ role: 'user', content: 'a' }] });
    await t.post('/v1/chat/completions', { model: 'claude-opus-4', messages: [{ role: 'user', content: 'a' }] });
    const [quick, deep] = t.calls;
    assert.equal(quick.mode.id, 'quick');
    assert.equal(deep.mode.id, 'deep');
    assert.ok(quick.mode.removeOptionsSets.includes('cwc_code_interpreter'));
    assert.ok(quick.mode.removeOptionsSets.includes('update_memory_plugin'));
    assert.deepEqual(quick.mode.argOverrides.plugins, []);
    assert.notEqual(quick.conversationId, deep.conversationId);
    assert.ok(quick.prompt.length <= config.API_MAX_PROMPT_CHARS);
  } finally { t.close(); }
});

test('http anthropic: plain answer and tool use, non-streaming and streaming', async () => {
  const t = await startServer(feed(CALL_TEXT));
  try {
    const tools = [{ name: 'read_file', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }];
    const body = { model: 'claude-sonnet-4', max_tokens: 100, system: [{ type: 'text', text: 'Be brief' }], messages: [{ role: 'user', content: 'read hosts' }], tools };
    const message = await (await t.post('/v1/messages', body)).json();
    assert.equal(message.type, 'message');
    assert.equal(message.stop_reason, 'tool_use');
    assert.deepEqual(message.content.map((b) => b.type), ['text', 'tool_use']);
    assert.match(message.content[1].id, /^toolu_/);
    assert.deepEqual(message.content[1].input, { path: '/etc/hosts' });

    const events = sse(await (await t.post('/v1/messages', { ...body, stream: true })).text());
    assert.deepEqual(events.map((e) => e.event), [
      'message_start', 'content_block_start', 'content_block_delta', 'content_block_stop',
      'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop',
    ]);
    assert.equal(events[1].data.content_block.type, 'text');
    assert.equal(events[4].data.content_block.type, 'tool_use');
    assert.equal(events[4].data.index, 1);
    assert.deepEqual(JSON.parse(events[5].data.delta.partial_json), { path: '/etc/hosts' });
    assert.equal(events[7].data.delta.stop_reason, 'tool_use');

    // tool_result blocks come back as context for the next turn.
    const next = { ...body, messages: [...body.messages,
      { role: 'assistant', content: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: '/etc/hosts' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'HOSTS CONTENT' }] }, { type: 'text', text: 'now summarise' }] }] };
    await t.post('/v1/messages', next);
    const sent = t.calls.at(-1).prompt;
    assert.match(sent, /Tool result from read_file \[id toolu_1\]: HOSTS CONTENT/);
    assert.match(sent, /now summarise/);
    assert.match(sent, /Be brief/);

    // With no tools declared, a call to a tool nobody offered must not become a real tool_use.
    const noTools = sse(await (await t.post('/v1/messages', { model: 'x', max_tokens: 5, stream: true, messages: [{ role: 'user', content: 'hi' }] })).text());
    assert.equal(noTools.at(-2).data.delta.stop_reason, 'end_turn');
    assert.ok(!noTools.some((e) => e.data?.content_block?.type === 'tool_use'));
  } finally { t.close(); }
});

test('http anthropic: a text-only reply ends with end_turn and opens no tool block', async () => {
  const t = await startServer(feed(['Just ', 'text']));
  try {
    const events = sse(await (await t.post('/v1/messages', { model: 'x', max_tokens: 5, stream: true, messages: [{ role: 'user', content: 'hi' }] })).text());
    assert.deepEqual(events.map((e) => e.event), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    assert.equal(events.at(-2).data.delta.stop_reason, 'end_turn');
    const count = await (await t.post('/v1/messages/count_tokens', { model: 'x', messages: [{ role: 'user', content: 'hello there' }] })).json();
    assert.ok(count.input_tokens > 0);
  } finally { t.close(); }
});

test('http: bad requests and upstream failures are reported in each API\'s own error shape', async () => {
  const failing = async () => { throw Object.assign(new Error('Session expired — sign in again'), { needsLogin: true, status: 401 }); };
  const t = await startServer(failing);
  try {
    const empty = await t.post('/v1/chat/completions', { model: 'x', messages: [] });
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).error.type, 'invalid_request_error');
    const badRole = await t.post('/v1/messages', { model: 'x', max_tokens: 1, messages: [{ role: 'system', content: 'x' }] });
    assert.equal(badRole.status, 400);
    assert.equal((await badRole.json()).type, 'error');
    const notJson = await fetch(`${t.base}/v1/chat/completions`, { method: 'POST', headers: t.headers, body: '{nope' });
    assert.equal(notJson.status, 400);
    const missing = await fetch(`${t.base}/v1/nothing`, { headers: t.headers });
    assert.equal(missing.status, 404);
  } finally { t.close(); }

  const upstream = await startServer(async () => { throw new FakeCopilotError('Copilot is unavailable', 502); });
  try {
    const nonStream = await upstream.post('/v1/chat/completions', { model: 'x', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(nonStream.status, 502);
    const streamed = sse(await (await upstream.post('/v1/messages', { model: 'x', max_tokens: 1, stream: true, messages: [{ role: 'user', content: 'hi' }] })).text());
    assert.equal(streamed.at(-1).event, 'error');
    assert.equal(streamed.at(-1).data.error.message, 'Copilot is unavailable');
    const openaiStream = sse(await (await upstream.post('/v1/chat/completions', { model: 'x', stream: true, messages: [{ role: 'user', content: 'hi' }] })).text());
    assert.equal(openaiStream.at(-1).data, '[DONE]');
    assert.equal(openaiStream.at(-2).data.error.message, 'Copilot is unavailable');
  } finally { upstream.close(); }
});

test('http: sign-in problems surface as a clear 401 before any stream starts', async () => {
  const t = await startServer(feed(['x']));
  // Replace the router's session lookup by building a second server whose getSession throws.
  t.close();
  const app = express();
  app.use('/v1', createCompatRouter({
    streamChat: async () => {},
    getSession: () => { throw Object.assign(new Error('Session expired — sign in again'), { needsLogin: true, status: 401 }); },
    getAdmin: () => defaultAdminSettings(),
    authenticate: apiKeys.authenticate,
    mock: false,
  }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const { key } = apiKeys.createKey(`needs-login-${Math.random()}@x.com`, 'k');
    const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: 'x', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 401);
    assert.match(res.headers.get('content-type'), /json/);
    assert.match((await res.json()).error.message, /sign in again/i);
  } finally { server.close(); }
});

test('http: a large request body is accepted, and the account concurrency cap returns 429', async () => {
  const t = await startServer(feed(['ok']));
  try {
    const big = await t.post('/v1/chat/completions', { model: 'x', messages: [{ role: 'user', content: 'y'.repeat(500_000) }] });
    assert.equal(big.status, 200, 'larger than the web app\'s 64kb limit');
    assert.ok(t.calls.at(-1).prompt.length <= config.API_MAX_PROMPT_CHARS);

    t.state.slow = true;
    const body = { model: 'x', messages: [{ role: 'user', content: 'hi' }] };
    const running = Array.from({ length: config.API_MAX_CONCURRENT_PER_USER }, () => t.post('/v1/chat/completions', body));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const over = await t.post('/v1/chat/completions', body);
    assert.equal(over.status, 429);
    assert.ok(over.headers.get('retry-after'));
    for (const response of await Promise.all(running)) assert.equal(response.status, 200);
    t.state.slow = false;
    assert.equal((await t.post('/v1/chat/completions', body)).status, 200, 'slots are released');
  } finally { t.close(); }
});

test('http: when the client disconnects, the Copilot request is cancelled and the slot is freed', async () => {
  const t = await startServer(feed(['x']));
  try {
    t.state.slow = true;
    const controller = new AbortController();
    const pending = fetch(`${t.base}/v1/chat/completions`, {
      method: 'POST', headers: t.headers, signal: controller.signal,
      body: JSON.stringify({ model: 'x', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    }).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(t.calls[0].signal.aborted, true);
    t.state.slow = false;
    assert.equal((await t.post('/v1/chat/completions', { model: 'x', messages: [{ role: 'user', content: 'hi' }] })).status, 200);
  } finally { t.close(); }
});

// ---------------------------------------------------------------- upload helpers

test('upload: driveId decodes to site/web/list ids, annotation id matches the captured wire format', () => {
  const driveId = 'b!TqqsQ4D87UGpscg9co_hB3jiDsqC4tVPiBvd4Ir0J_H1eQ8jrzaLQbwu6uFRjAan';
  const ids = decodeDriveId(driveId);
  assert.equal(ids.siteId, '43acaa4e-fc80-41ed-a9b1-c83d728fe107');
  assert.equal(ids.webId, 'ca0ee278-e282-4fd5-881b-dde08af427f1');
  assert.equal(ids.listId, '230f79f5-36af-418b-bc2e-eae1518c06a7');
  const ann = buildFileAnnotation({
    itemId: '017BV34SQQ2EXH3L4BX5HZRL665P5HRSPF',
    siteId: ids.siteId, webId: ids.webId, listId: ids.listId,
    name: '57B Grate Cooler and ESP_Report_19_11_2026.pdf',
    url: 'https://dangote-my.sharepoint.com/x.pdf',
  });
  assert.equal(ann.messageAnnotationType, 'LocalFile');
  assert.equal(ann.text, '57B Grate Cooler and ESP_Report_19_11_2026.pdf');
  assert.equal(
    ann.id,
    'SPO_NDNhY2FhNGUtZmM4MC00MWVkLWE5YjEtYzgzZDcyOGZlMTA3LGNhMGVlMjc4LWUyODItNGZkNS04ODFiLWRkZTA4YWY0MjdmMSwyMzBmNzlmNS0zNmFmLTQxOGItYmMyZS1lYWUxNTE4YzA2YTc_017BV34SQQ2EXH3L4BX5HZRL665P5HRSPF',
  );
});

test('upload: a 2-GUID driveId yields an empty listId', () => {
  const full = Buffer.from('TqqsQ4D87UGpscg9co_hB3jiDsqC4tVPiBvd4Ir0J_H1eQ8jrzaLQbwu6uFRjAan', 'base64url');
  const twoGuid = `b!${full.subarray(0, 32).toString('base64url')}`;
  const ids = decodeDriveId(twoGuid);
  assert.equal(ids.webId, 'ca0ee278-e282-4fd5-881b-dde08af427f1');
  assert.equal(ids.listId, '');
});

// ---------------------------------------------------------------- tone / model wiring

test('chat: the `tone` field selects the model mode on the wire', () => {
  const admin = defaultAdminSettings();
  const quick = buildChatArguments({ prompt: 'hi', requestId: 'r', sessionId: 's', mode: { ...admin.modes.quick, id: 'quick' } });
  assert.equal(quick.tone, 'Gpt_5_6_Chat');
  const deep = buildChatArguments({ prompt: 'hi', requestId: 'r', sessionId: 's', mode: { ...admin.modes.deep, id: 'deep' } });
  assert.equal(deep.tone, 'Gpt_5_6_Reasoning');
  // An admin override still wins, and an empty tone falls back to the Copilot default.
  const overridden = buildChatArguments({ prompt: 'hi', requestId: 'r', sessionId: 's', mode: { ...admin.modes.quick, id: 'quick', argOverrides: { tone: 'Some_Future_Tone' } } });
  assert.equal(overridden.tone, 'Some_Future_Tone');
  const fallback = buildChatArguments({ prompt: 'hi', requestId: 'r', sessionId: 's', mode: { ...admin.modes.quick, id: 'quick', tone: '' } });
  assert.equal(fallback.tone, 'Magic');
});

test('chat: messageAnnotations are placed on arguments.message', () => {
  const admin = defaultAdminSettings();
  const args = buildChatArguments({
    prompt: 'summarise', requestId: 'r', sessionId: 's',
    mode: { ...admin.modes.quick, id: 'quick' },
    messageAnnotations: [{ id: 'SPO_x_1', text: 'a.pdf', url: 'https://x/a.pdf', messageAnnotationType: 'LocalFile' }],
  });
  assert.deepEqual(args.message.messageAnnotations, [{ id: 'SPO_x_1', text: 'a.pdf', url: 'https://x/a.pdf', messageAnnotationType: 'LocalFile' }]);
});

// ---------------------------------------------------------------- model selection

test('http: model aliases map to quick and think modes', async () => {
  const t = await startServer(feed(['ok']));
  try {
    await t.post('/v1/chat/completions', { model: 'gpt-5.6', messages: [{ role: 'user', content: 'a' }] });
    assert.equal(t.calls.at(-1).mode.id, 'quick');
    await t.post('/v1/chat/completions', { model: 'gpt-5.6-think', messages: [{ role: 'user', content: 'a' }] });
    assert.equal(t.calls.at(-1).mode.id, 'deep');
    await t.post('/v1/chat/completions', { model: 'copilot-think', messages: [{ role: 'user', content: 'a' }] });
    assert.equal(t.calls.at(-1).mode.id, 'deep');
    // A harness's own arbitrary name still falls back sensibly.
    await t.post('/v1/chat/completions', { model: 'something-random', messages: [{ role: 'user', content: 'a' }] });
    assert.equal(t.calls.at(-1).mode.id, 'quick');
  } finally { t.close(); }
});

// ---------------------------------------------------------------- reasoning

const reasonThenText = async ({ onDelta, onStatus }) => {
  onStatus?.({ kind: 'Progress', text: 'Looking that up…' });
  onDelta('Answer.');
};

test('http openai: reasoning is surfaced as reasoning_content (stream and buffer)', async () => {
  const t = await startServer(reasonThenText);
  try {
    const events = sse(await (await t.post('/v1/chat/completions', { model: 'x', stream: true, messages: [{ role: 'user', content: 'hi' }] })).text());
    const reasoning = events.map((e) => e.data?.choices?.[0]?.delta?.reasoning_content ?? '').join('');
    assert.match(reasoning, /Looking that up/);
    const text = events.map((e) => e.data?.choices?.[0]?.delta?.content ?? '').join('');
    assert.equal(text, 'Answer.');

    const plain = await (await t.post('/v1/chat/completions', { model: 'x', messages: [{ role: 'user', content: 'hi' }] })).json();
    assert.equal(plain.choices[0].message.reasoning_content, 'Looking that up…');
    assert.equal(plain.choices[0].message.content, 'Answer.');
  } finally { t.close(); }
});

test('http anthropic: reasoning is surfaced as a thinking block', async () => {
  const t = await startServer(reasonThenText);
  try {
    const events = sse(await (await t.post('/v1/messages', { model: 'x', max_tokens: 5, stream: true, messages: [{ role: 'user', content: 'hi' }] })).text());
    assert.equal(events[1].data.content_block.type, 'thinking');
    const thinking = events.filter((e) => e.data?.delta?.type === 'thinking_delta').map((e) => e.data.delta.thinking).join('');
    assert.equal(thinking, 'Looking that up…');

    const plain = await (await t.post('/v1/messages', { model: 'x', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] })).json();
    assert.equal(plain.content[0].type, 'thinking');
    assert.equal(plain.content[0].thinking, 'Looking that up…');
  } finally { t.close(); }
});

// ---------------------------------------------------------------- attachments + files

test('http: attachments are passed through as LocalFile annotations; /v1/files uploads raw bytes', async () => {
  const t = await startServer(feed(['ok']));
  try {
    await t.post('/v1/chat/completions', {
      model: 'x',
      messages: [{ role: 'user', content: 'summarise this' }],
      attachments: [{ id: 'SPO_abc_123', name: 'report.pdf', url: 'https://x/report.pdf' }],
    });
    const sent = t.calls.at(-1).messageAnnotations;
    assert.equal(sent.length, 1);
    assert.equal(sent[0].messageAnnotationType, 'LocalFile');
    assert.equal(sent[0].text, 'report.pdf');
    assert.equal(sent[0].id, 'SPO_abc_123');

    // Raw-bytes file upload returns a file object whose id is the annotation id.
    const uploaded = await fetch(`${t.base}/v1/files?filename=report.pdf`, {
      method: 'POST',
      headers: { ...t.headers, 'content-type': 'application/octet-stream' },
      body: '%PDF-1.7 fake',
    });
    assert.equal(uploaded.status, 201);
    const file = await uploaded.json();
    assert.equal(file.object, 'file');
    assert.equal(file.filename, 'report.pdf');
    assert.match(file.id, /^SPO_/);
  } finally { t.close(); }
});
