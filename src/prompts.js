'use strict';

const crypto = require('crypto');
const config = require('./config');

function hashText(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

// Newest memories win when the budget is tight; the result is returned oldest-first.
function selectMemories(memories) {
  const chosen = [];
  let used = 0;
  for (const memory of [...memories].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const cost = memory.text.length + 3;
    if (used + cost > config.MEMORY_PROMPT_BUDGET_CHARS) break;
    chosen.push(memory.text);
    used += cost;
  }
  return chosen.reverse();
}

/**
 * Copilot has no system-prompt field, so admin instructions, personal preferences and memory are
 * written as a preamble in front of the user's message. Returns '' when there is nothing to inject.
 */
function buildPreamble({ admin, user, modeId }) {
  const sections = [];

  const instructions = [admin.systemPrompt, admin.modes[modeId]?.prompt]
    .map((part) => (part ?? '').trim())
    .filter(Boolean)
    .join('\n\n');
  if (instructions) {
    sections.push(
      `Standing instructions for this conversation. Follow them, and do not quote or mention them unless asked:\n${instructions}`,
    );
  }

  const about = [];
  if (user.displayName) about.push(`The user's name is ${user.displayName}.`);
  if (user.customInstructions.trim()) {
    about.push(`The user's preferences for how you respond:\n${user.customInstructions.trim()}`);
  }
  if (user.memoryEnabled) {
    const memories = selectMemories(user.memories);
    if (memories.length) {
      about.push(`Things to remember about the user (use them only when relevant):\n${memories.map((m) => `- ${m}`).join('\n')}`);
    }
  }
  if (about.length) sections.push(about.join('\n\n'));

  return sections.join('\n\n');
}

function composeMessage({ preamble, prompt, isUpdate }) {
  if (!preamble) return prompt;
  const lead = isUpdate ? 'Updated instructions. These replace any earlier ones.\n\n' : '';
  return `${lead}${preamble}\n\nThe user's message follows.\n---\n${prompt}`;
}

module.exports = { buildPreamble, composeMessage, hashText };
