'use strict';

// Fresh copy every call so callers can mutate freely.
function defaultAdminSettings() {
  const baseMode = {
    prompt: '',
    // The Copilot `tone` field in the chat invocation. This is what actually selects the model
    // mode on the wire (captured from the browser): quick = Gpt_5_6_Chat, think = Gpt_5_6_Reasoning.
    tone: '',
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
        tone: 'Gpt_5_6_Chat',
        label: 'Quick response',
        description: 'GPT-5.6 Sol quick response — fast answers for everyday questions',
        timeoutMs: 120_000,
      },
      deep: {
        ...baseMode,
        tone: 'Gpt_5_6_Reasoning',
        label: 'Think deeper',
        description: 'GPT-5.6 Sol think — takes longer to work through harder problems',
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
