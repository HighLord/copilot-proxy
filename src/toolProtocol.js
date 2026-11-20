'use strict';

// Copilot has no native function calling, so tool use is emulated: the prompt lists the harness's tools
// and asks for a strict <tool_call> block, and the parser below turns those blocks back into structured calls.

const OPEN_TAG = '<tool_call>';
const CLOSE_TAG = '</tool_call>';
const FENCE_CLOSE = '```';
// Models sometimes wrap the call in a code fence instead of the tag, so both spellings are accepted.
const OPENERS = Object.freeze([
  { text: OPEN_TAG, kind: 'tag' },
  { text: '```tool_call', kind: 'fence' },
  { text: '```tool-call', kind: 'fence' },
  { text: '```toolcall', kind: 'fence' },
]);
const LONGEST_OPENER = Math.max(...OPENERS.map((opener) => opener.text.length));

const CHARS_PER_TOKEN = 4;
const estimateTokens = (chars) => Math.ceil(chars / CHARS_PER_TOKEN);

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

// First complete JSON object or array inside free text, respecting strings. Tolerates chatter around it.
function firstJsonValue(text) {
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{' || ch === '[') {
      depth += 1;
    } else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch { /* try the lenient form below */ }
  try {
    // Trailing commas are the most common slip in model-written JSON.
    return JSON.parse(text.replace(/,\s*([}\]])/g, '$1'));
  } catch {
    return null;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeCall(raw, resolveName) {
  if (!isPlainObject(raw)) return null;
  const fn = isPlainObject(raw.function) ? raw.function : raw;
  const name = resolveName(fn.name ?? raw.tool ?? raw.tool_name ?? raw.function_name);
  if (!name) return null;
  let args = fn.arguments ?? fn.parameters ?? fn.input ?? fn.args ?? raw.arguments ?? raw.parameters ?? raw.input ?? {};
  if (typeof args === 'string') args = tryParseJson(args) ?? {};
  if (!isPlainObject(args)) args = {};
  return { name, arguments: args };
}

// Returns a list of { name, arguments }, or null when nothing usable was found.
function parseCallBody(body, resolveName) {
  const cleaned = body.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const json = firstJsonValue(cleaned);
  if (json === null) return null;
  const value = tryParseJson(json);
  if (value === null) return null;
  const calls = (Array.isArray(value) ? value : [value]).map((raw) => normalizeCall(raw, resolveName)).filter(Boolean);
  return calls.length > 0 ? calls : null;
}

// Longest tail of `buffer` that could still become an opener once more text arrives.
function partialOpenerLength(buffer) {
  const max = Math.min(LONGEST_OPENER - 1, buffer.length);
  for (let length = max; length > 0; length -= 1) {
    const tail = buffer.slice(-length);
    if (OPENERS.some((opener) => opener.text.startsWith(tail))) return length;
  }
  return 0;
}

function findOpener(buffer) {
  let best = null;
  for (const opener of OPENERS) {
    const index = buffer.indexOf(opener.text);
    if (index >= 0 && (best === null || index < best.index)) best = { index, opener };
  }
  return best;
}

/**
 * Incremental parser. push(chunk) and end() return events:
 *   { type: 'text', text }  or  { type: 'tool_call', name, arguments }
 * Text is passed through as it arrives (holding back only a possible half-written opener).
 * Once a call has been seen, any following prose is discarded: the model must stop after calling, so
 * anything after it would be an invented tool result.
 */
function createToolCallParser({ toolNames = null, maxCalls = Infinity } = {}) {
  const known = toolNames ? new Map(toolNames.map((name) => [name.toLowerCase(), name])) : null;
  let buffer = '';
  let inBlock = null;
  let callsSeen = 0;

  const resolveName = (raw) => {
    if (typeof raw !== 'string' || raw.trim() === '') return null;
    const name = raw.trim();
    return known ? (known.get(name.toLowerCase()) ?? null) : name;
  };

  const emitText = (out, text) => {
    if (text && callsSeen === 0) out.push({ type: 'text', text });
  };

  const finishBlock = (out, opener, body, closed) => {
    const calls = parseCallBody(body, resolveName);
    if (calls === null) {
      // Not a usable call: show it as text so nothing the model said is silently lost.
      const closer = closed ? (opener.kind === 'tag' ? CLOSE_TAG : FENCE_CLOSE) : '';
      emitText(out, opener.text + body + closer);
      return;
    }
    for (const call of calls) {
      if (callsSeen >= maxCalls) break;
      callsSeen += 1;
      out.push({ type: 'tool_call', name: call.name, arguments: call.arguments });
    }
  };

  function drain(out) {
    for (;;) {
      if (inBlock === null) {
        const found = findOpener(buffer);
        if (found) {
          emitText(out, buffer.slice(0, found.index));
          buffer = buffer.slice(found.index + found.opener.text.length);
          inBlock = found.opener;
          continue;
        }
        const hold = partialOpenerLength(buffer);
        emitText(out, buffer.slice(0, buffer.length - hold));
        buffer = buffer.slice(buffer.length - hold);
        return;
      }
      const closer = inBlock.kind === 'tag' ? CLOSE_TAG : FENCE_CLOSE;
      const end = buffer.indexOf(closer);
      if (end < 0) return;
      finishBlock(out, inBlock, buffer.slice(0, end), true);
      buffer = buffer.slice(end + closer.length);
      inBlock = null;
    }
  }

  return {
    push(chunk) {
      const out = [];
      buffer += chunk;
      drain(out);
      return out;
    },
    end() {
      const out = [];
      if (inBlock !== null) {
        // The closing marker never came; accept the call if the JSON is complete anyway.
        finishBlock(out, inBlock, buffer, false);
      } else {
        emitText(out, buffer);
      }
      buffer = '';
      inBlock = null;
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Prompt rendering
// ---------------------------------------------------------------------------

const MIN_BUDGET_CHARS = 2_000;
const SECTION_OVERHEAD_CHARS = 160;
const TOOLS_SHARE = 0.4;
const SYSTEM_SHARE = 0.25;
const FIRST_MESSAGE_SHARE = 0.25;
// Per-message ceilings as shares of the whole budget, so raising the budget really does allow longer messages.
const CAP_SHARES = Object.freeze({ firstMessage: 0.15, user: 0.5, assistant: 0.25, toolResult: 0.3, callArguments: 0.09 });
const capsFor = (limit) => Object.fromEntries(Object.entries(CAP_SHARES).map(([key, share]) => [key, Math.floor(limit * share)]));
const HEAD_SHARE = 0.7;
const MAX_SCHEMA_DEPTH = 2;
const MAX_PARAMS_SHOWN = 10;

function clip(text, max) {
  if (text.length <= max) return text;
  if (max <= 40) return text.slice(0, Math.max(0, max));
  const marker = `\n...[${text.length - max + 30} characters omitted]...\n`;
  const room = Math.max(0, max - marker.length);
  const head = Math.floor(room * HEAD_SHARE);
  return `${text.slice(0, head)}${marker}${text.slice(text.length - (room - head))}`;
}

function oneLine(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 3))}...` : flat;
}

function firstSentence(text, max) {
  const flat = oneLine(text, Number.MAX_SAFE_INTEGER);
  const stop = flat.search(/[.!?](\s|$)/);
  return oneLine(stop > 20 ? flat.slice(0, stop + 1) : flat, max);
}

function describeType(prop, depth = 0) {
  if (!isPlainObject(prop)) return 'any';
  if (Array.isArray(prop.enum) && prop.enum.length > 0) {
    return prop.enum.slice(0, 8).map((value) => JSON.stringify(value)).join('|');
  }
  const alternatives = prop.anyOf ?? prop.oneOf;
  if (Array.isArray(alternatives)) return [...new Set(alternatives.map((alt) => describeType(alt, depth)))].join('|');
  let { type } = prop;
  if (Array.isArray(type)) type = type.filter((t) => t !== 'null').join('|');
  if (type === 'array') return `${describeType(prop.items, depth)}[]`;
  if (type === 'object' && isPlainObject(prop.properties) && depth < MAX_SCHEMA_DEPTH) {
    return `{${schemaParams(prop, depth + 1).map((p) => `${p.name}${p.required ? '' : '?'}: ${p.type}`).join(', ')}}`;
  }
  return type || 'any';
}

function schemaParams(schema, depth = 0) {
  const properties = isPlainObject(schema?.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  return Object.entries(properties).map(([name, prop]) => ({
    name,
    type: describeType(prop, depth),
    required: required.has(name),
    description: isPlainObject(prop) ? prop.description ?? '' : '',
  }));
}

const TOOL_LEVELS = Object.freeze([
  { description: 220, paramDescription: 100, signatures: true },
  { description: 110, paramDescription: 0, signatures: true },
  { description: 50, paramDescription: 0, signatures: true },
  { description: 0, paramDescription: 0, signatures: true },
  { description: 0, paramDescription: 0, signatures: false },
]);

function renderTools(tools, level) {
  const spec = TOOL_LEVELS[level];
  if (!spec.signatures) return tools.map((tool) => tool.name).join(', ');
  return tools.map((tool) => {
    const params = schemaParams(tool.parameters);
    const shown = params.slice(0, MAX_PARAMS_SHOWN)
      .map((p) => `${p.name}${p.required ? '' : '?'}: ${p.type}`);
    if (params.length > MAX_PARAMS_SHOWN) shown.push('...');
    let block = `- ${tool.name}(${shown.join(', ')})`;
    if (spec.description > 0 && tool.description) block += `: ${firstSentence(tool.description, spec.description)}`;
    if (spec.paramDescription > 0) {
      for (const p of params.slice(0, MAX_PARAMS_SHOWN).filter((item) => item.description)) {
        block += `\n    ${p.name}: ${oneLine(p.description, spec.paramDescription)}`;
      }
    }
    return block;
  }).join('\n');
}

// Richest rendering that fits the budget; falls back to names only, then to a cut-off list.
function fitTools(tools, budget) {
  for (let level = 0; level < TOOL_LEVELS.length; level += 1) {
    const text = renderTools(tools, level);
    if (text.length <= budget) return { text, level, omitted: 0 };
  }
  const names = tools.map((tool) => tool.name);
  let kept = names.length;
  while (kept > 1 && names.slice(0, kept).join(', ').length + 40 > budget) kept -= 1;
  const note = kept < names.length ? ` (+${names.length - kept} more tools not shown)` : '';
  return { text: names.slice(0, kept).join(', ') + note, level: TOOL_LEVELS.length, omitted: names.length - kept };
}

// Minimal, always-on tool protocol. This is mechanism, not guidance prose: the parser depends on the
// call format, and tool_choice / response_format are constraints the harness itself requested. All
// prose instructions come from the proxy owner's own `instructions`, editable in the web settings.
function buildToolProtocol({ hasTools, toolsForbidden, toolChoice, responseFormat }) {
  const lines = [];
  if (hasTools) {
    lines.push(
      `To call a tool, write one block per call in this exact form: ${OPEN_TAG}{"name": "TOOL_NAME", "arguments": {"param": "value"}}${CLOSE_TAG}`,
      'After the last block, stop and wait for the result.',
    );
    if (toolChoice === 'required') lines.push('In this reply you MUST call at least one tool.');
    else if (isPlainObject(toolChoice)) lines.push(`In this reply you MUST call the tool "${toolChoice.name}".`);
  } else if (toolsForbidden) {
    lines.push('Do not call any tools in this reply. Answer in plain text.');
  }
  if (responseFormat === 'json') lines.push('Reply with a single valid JSON value and nothing else (no code fence, no commentary).');
  return lines.join('\n');
}

const FOOTER = 'Respond now as the assistant to the latest message above. If any listed tool can help, call it.';

function renderMessage(message, caps) {
  if (message.role === 'user') return `User: ${clip(message.text, caps.user)}`;
  if (message.role === 'tool') {
    const label = message.isError ? 'Tool error' : 'Tool result';
    return `${label} from ${message.name || 'tool'} [id ${message.toolCallId}]: ${clip(message.text || '(empty)', caps.toolResult)}`;
  }
  const parts = [];
  if (message.text) parts.push(`Assistant: ${clip(message.text, caps.assistant)}`);
  for (const call of message.toolCalls ?? []) {
    parts.push(`Assistant called ${call.name} [id ${call.id}] with ${clip(JSON.stringify(call.arguments ?? {}), caps.callArguments)}`);
  }
  return parts.join('\n') || 'Assistant: (no text)';
}

function renderTranscript(messages, budget, caps) {
  const lines = messages.map((message) => renderMessage(message, caps));
  const total = lines.reduce((sum, line) => sum + line.length + 1, 0);
  if (total <= budget) return { text: lines.join('\n'), omitted: 0 };

  // Keep the opening request (it usually states the task) and as many of the newest messages as fit.
  const pinFirst = messages[0].role === 'user' && lines.length > 2;
  const pinned = pinFirst ? clip(lines[0], Math.min(caps.firstMessage, Math.floor(budget * FIRST_MESSAGE_SHARE))) : '';
  const markerReserve = 80;
  let used = (pinned ? pinned.length + 1 : 0) + markerReserve;
  const tail = [];
  for (let i = lines.length - 1; i >= (pinFirst ? 1 : 0); i -= 1) {
    if (used + lines[i].length + 1 <= budget) {
      tail.unshift(lines[i]);
      used += lines[i].length + 1;
    } else {
      // The newest message is always included, shortened if it has to be.
      if (tail.length === 0) tail.unshift(clip(lines[i], Math.max(200, budget - used - 1)));
      break;
    }
  }
  const kept = tail.length + (pinned ? 1 : 0);
  const omitted = lines.length - kept;
  const marker = omitted > 0 ? `[${omitted} earlier message${omitted === 1 ? '' : 's'} omitted to fit the length limit]` : '';
  return { text: [pinned, marker, ...tail].filter(Boolean).join('\n'), omitted };
}

/**
 * Builds the single message sent to Copilot, never longer than `budget` characters.
 * messages: [{ role: 'user', text } | { role: 'assistant', text, toolCalls: [{id,name,arguments}] }
 *            | { role: 'tool', toolCallId, name, text, isError }]
 * instructions: the proxy owner's own instructions, editable in the web settings. The ONLY prose
 *               guidance injected by this proxy; when empty, nothing is injected.
 */
function renderPrompt({ system = '', instructions = '', messages, tools = [], toolChoice = 'auto', responseFormat = null, budget }) {
  if (!Array.isArray(messages) || messages.length === 0) throw new Error('messages must not be empty');
  const limit = Math.max(MIN_BUDGET_CHARS, budget);
  const toolsForbidden = tools.length > 0 && toolChoice === 'none';
  const usableTools = toolsForbidden ? [] : tools;

  const sections = [];

  // 1. The proxy owner's instructions (editable in the web settings). Nothing else is auto-injected.
  const trimmedInstructions = String(instructions ?? '').trim();
  if (trimmedInstructions) sections.push(trimmedInstructions);

  // 2. Tool protocol: the call format + any tool_choice / JSON constraints. Always-on mechanism.
  const protocol = buildToolProtocol({ hasTools: usableTools.length > 0, toolsForbidden, toolChoice, responseFormat });

  const fixedOverhead = trimmedInstructions.length + protocol.length + FOOTER.length + SECTION_OVERHEAD_CHARS;
  let remaining = Math.max(300, limit - fixedOverhead);

  // 3. Tools list.
  let toolStats = { level: -1, omitted: 0 };
  if (usableTools.length > 0) {
    const fitted = fitTools(usableTools, Math.floor(remaining * TOOLS_SHARE));
    sections.push(`TOOLS AVAILABLE THROUGH THE HARNESS:\n${fitted.text}`);
    remaining -= fitted.text.length;
    toolStats = fitted;
  }

  if (protocol) sections.push(protocol);

  // 4. The harness's own system prompt, passed through (not proxy guidance).
  const trimmedSystem = String(system ?? '').trim();
  if (trimmedSystem) {
    const text = clip(trimmedSystem, Math.floor(remaining * SYSTEM_SHARE));
    sections.push(`THE HARNESS'S OWN INSTRUCTIONS (shortened if long):\n${text}`);
    remaining -= text.length;
  }

  const transcript = renderTranscript(messages, Math.max(300, remaining), capsFor(limit));
  sections.push(`CONVERSATION SO FAR:\n${transcript.text}`);
  sections.push(FOOTER);

  let prompt = sections.join('\n\n');
  if (prompt.length > limit) {
    // Last resort when even the minimum does not fit: cut the middle of the transcript.
    const overflow = prompt.length - limit;
    const shortened = clip(transcript.text, Math.max(100, transcript.text.length - overflow));
    prompt = sections.slice(0, -2).concat(`CONVERSATION SO FAR:\n${shortened}`, FOOTER).join('\n\n');
  }
  // Absolute guarantee: the rendered prompt never exceeds the budget, whatever the harness sends.
  if (prompt.length > limit) prompt = prompt.slice(0, limit);
  return {
    prompt,
    stats: { chars: prompt.length, omittedMessages: transcript.omitted, toolDetailLevel: toolStats.level, omittedTools: toolStats.omitted },
  };
}

module.exports = {
  OPEN_TAG,
  CLOSE_TAG,
  createToolCallParser,
  renderPrompt,
  estimateTokens,
  MIN_BUDGET_CHARS,
};
