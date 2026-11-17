'use strict';

// Fresh copy every call so callers can mutate freely.
function defaultAdminSettings() {
  const baseMode = {
    prompt: '',
    // Applied on top of config.OPTIONS_SETS for this mode.
    addOptionsSets: [],
    removeOptionsSets: [],
    // Deep-merged into the SignalR "chat" arguments / arguments.message / URL query string.
    argOverrides: {},
    messageOverrides: {},
    urlParams: {},
  };
  return {
    appName: 'Copilot',
    systemPrompt: '',
    defaultMode: 'quick',
    modes: {
      quick: {
        ...baseMode,
        label: 'Quick response',
        description: 'Fast answers for everyday questions',
        timeoutMs: 120_000,
      },
      deep: {
        ...baseMode,
        label: 'Think deeper',
        description: 'Takes longer to work through harder problems',
        timeoutMs: 300_000,
      },
    },
    starters: [
      { label: 'Write', icon: 'pen', prompt: 'Help me write a clear, friendly message about ' },
      { label: 'Learn', icon: 'cap', prompt: 'Explain this to me like I am new to it: ' },
      { label: 'Code', icon: 'code', prompt: 'Help me write and debug some code. Here is what I am working on: ' },
      { label: 'Life stuff', icon: 'coffee', prompt: 'I am trying to make a decision and could use a second opinion: ' },
    ],
  };
}

function defaultUserData() {
  return { displayName: '', customInstructions: '', memoryEnabled: true, memories: [] };
}

module.exports = { defaultAdminSettings, defaultUserData };
