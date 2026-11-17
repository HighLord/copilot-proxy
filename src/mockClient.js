'use strict';

// Stand-in for copilotClient.js, enabled with COPILOT_MOCK=1. It lets the UI and storage be
// developed and tested without a Copilot token. Prompts containing "/fail" simulate an upstream error.
const { CopilotError } = require('./copilotClient');

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new CopilotError('Client disconnected'));
    }, { once: true });
  });

async function streamChat({ prompt, onDelta, onStatus, signal, mode = {} }) {
  const deep = mode.id === 'deep';
  if (prompt.includes('/fail')) {
    await sleep(300, signal);
    throw new CopilotError('Mock upstream failure');
  }
  if (deep) {
    onStatus?.({ kind: 'Progress', text: 'Thinking through the problem' });
    await sleep(1500, signal);
  }
  const hasInstructions = prompt.startsWith('Standing instructions') || prompt.startsWith('Updated instructions') || prompt.includes("The user's message follows.");
  const userText = prompt.split('---\n').pop().slice(0, 300);
  const reply = [
    `**${deep ? 'Deep' : 'Quick'} mock reply.** You said: "${userText}"`,
    '',
    `Instructions injected: **${hasInstructions ? 'yes' : 'no'}**`,
    '',
    '## What this exercises',
    '',
    '- Streaming with *inline* formatting and `inline code`',
    '- A numbered list:',
    '  1. first nested item',
    '  2. second nested item',
    '',
    '```js',
    'const answer = 6 * 7;',
    'console.log(answer);',
    '```',
    '',
    '| Mode | Latency |',
    '| :-- | --: |',
    '| quick | low |',
    '| deep | high |',
    '',
    '> Block quotes render too. See [Anthropic](https://www.anthropic.com).',
  ].join('\n');
  for (let i = 0; i < reply.length; i += 12) {
    const chunk = reply.slice(i, i + 12);
    onDelta(chunk);
    await sleep(15, signal);
  }
  return reply;
}

module.exports = { streamChat, CopilotError };
