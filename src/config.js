'use strict';

const path = require('path');

const CLIENT_INFO = Object.freeze({
  clientPlatform: 'ccmcopilot-web',
  clientAppName: 'Office',
  clientEntrypoint: 'ccmcopilot-officeweb',
  ProductCategory: 'Chat',
  clientAppType: 'Web',
  productEntryPoint: 'ChatPanel',
  deviceOS: 'Windows',
  deviceType: 'Desktop',
  clientPlatformVersion: '10',
});

// Copied from the captured browser request. Copilot may change these at any time.
const OPTIONS_SETS = Object.freeze([
  'search_result_progress_messages_with_search_queries', 'update_textdoc_response_after_streaming',
  'deepleo_networking_timeout_10minutes_canmore', 'enable_search_result_progress_messages',
  'cwc_flux_image', 'cwc_code_interpreter', 'cwc_code_interpreter_amsfix', 'cwcfluxgptv',
  'flux_v3_gptv_enable_upload_multi_image_in_turn_wo_ch', 'gptvnorm2048',
  'cwc_code_interpreter_citation_fix', 'code_interpreter_interactive_charts',
  'cwc_code_interpreter_interactive_charts_inline_image', 'code_interpreter_matplotlib_patching',
  'cwc_fileupload_odb', 'update_memory_plugin', 'add_custom_instructions', 'cwc_flux_v3',
  'flux_v3_progress_messages', 'enable_batch_token_processing', 'enable_gg_gpt',
  'enable_inferred_memory_read', 'cwc_table_context', 'flux_v3_references',
  'flux_v3_references_entities', 'flux_v3_references_ci', 'add_filestore_filetype',
  'cwc_code_interpreter_citation_sourceannotations', 'cdxcwc_code_interpreter_hallucinated_url_filter',
  'flux_v3_image_gen_enable_dimensions', 'flux_v3_image_gen_enable_non_watermarked_storage',
  'flux_v3_image_gen_enable_icon_dimensions', 'flux_v3_image_gen_enable_system_text_with_params',
  'flux_v3_image_gen_enable_designer_dimensions_meta_prompting_in_system_prompts',
  'flux_v3_image_gen_enable_story', 'rich_responses', 'enable_strongly_typed_bing_grounding_conversion',
  'web_search_citations_answer_cards', 'pages_citations', 'pages_citations_multiturn',
]);

const ALLOWED_MESSAGE_TYPES = Object.freeze([
  'Chat', 'Suggestion', 'InternalSearchQuery', 'Disengaged', 'InternalLoaderMessage', 'Progress',
  'GeneratedCode', 'RenderCardRequest', 'AdsQuery', 'SemanticSerp', 'GenerateContentQuery',
  'GenerateGraphicArt', 'SearchQuery', 'ConfirmationCard', 'AuthError', 'DeveloperLogs',
  'TriggerPlugin', 'HintInvocation', 'MemoryUpdate', 'EndOfRequest', 'TriggerConfirmation',
  'ResumeInvokeAction', 'ResumeUserInputRequest', 'TriggerUserInputRequest', 'EscapeHatch',
  'TriggerPluginAuth', 'ResumePluginAuth', 'SideBySide', 'ReferencesListComplete',
  'CompleteExtension', 'TriggerExtension', 'SwitchRespondingEndpoint', 'PromotedCapabilities',
  'NetworkInfo',
]);

module.exports = Object.freeze({
  PORT: Number(process.env.PORT ?? 3000),
  // Optional secret for /api/admin/*. When unset, any signed-in user may edit admin settings.
  ADMIN_API_KEY: process.env.ADMIN_API_KEY ?? '',
  DATA_DIR: path.resolve(process.env.DATA_DIR ?? path.join(__dirname, '..', 'data')),
  // COPILOT_MOCK=1 swaps the Copilot WebSocket and the login flow for local fakes.
  MOCK: process.env.COPILOT_MOCK === '1',
  // COPILOT_DEBUG_FRAMES=1 writes every SignalR frame to DATA_DIR/debug/*.jsonl (access_token is never logged).
  DEBUG_FRAMES: process.env.COPILOT_DEBUG_FRAMES === '1',
  // COPILOT_DEBUG_SCREENSHOTS=1 saves sign-in page screenshots to ./tmp. Off by default: they can show an
  // email address or a signed-in chat, and concurrent users share the same filenames.
  DEBUG_SCREENSHOTS: process.env.COPILOT_DEBUG_SCREENSHOTS === '1',
  VARIANTS: process.env.COPILOT_VARIANTS ?? '',
  TIME_ZONE: process.env.COPILOT_TIME_ZONE ?? 'UTC',
  TIME_ZONE_OFFSET: Number(process.env.COPILOT_TIME_ZONE_OFFSET ?? 0),

  CHATHUB_BASE_URL: 'wss://substrate.office.com/m365Copilot/Chathub',
  ORIGIN: 'https://copilot.cloud.microsoft',
  USER_AGENT:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36',

  REQUEST_TIMEOUT_MS: 120_000,
  MAX_PROMPT_CHARS: 8_000,
  TOKEN_EXPIRY_SKEW_SECONDS: 60,
  JSON_BODY_LIMIT: '64kb',

  // ---- API for external tools (OpenAI- and Anthropic-compatible, served under /v1) ----
  API_JSON_BODY_LIMIT: '8mb',
  // Copilot takes one bounded message per turn, so a harness's context is trimmed to fit.
  // Raise COPILOT_API_MAX_PROMPT_CHARS only after testing what Copilot really accepts.
  API_MAX_PROMPT_CHARS: Number(process.env.COPILOT_API_MAX_PROMPT_CHARS) || 8_000,
  API_MAX_CONCURRENT_PER_USER: 3,
  API_MAX_KEYS_PER_USER: 10,
  // Copilot features a harness must not trigger: its code sandbox, and the memory writer/reader
  // (so harness traffic never ends up in, or draws on, the person's own Copilot memory).
  API_DISABLED_OPTIONS_PATTERN: /code_interpreter|^update_memory_plugin$|^enable_inferred_memory_read$/,
  SSE_HEARTBEAT_MS: 15_000,

  MAX_SYSTEM_PROMPT_CHARS: 3_000,
  MAX_API_INSTRUCTIONS_CHARS: 3_000,
  MAX_CUSTOM_INSTRUCTIONS_CHARS: 1_500,
  MAX_MEMORY_ITEMS: 100,
  MAX_MEMORY_CHARS: 400,
  // How much of the 8k message budget memories may use when injected.
  MEMORY_PROMPT_BUDGET_CHARS: 2_000,
  MAX_TITLE_CHARS: 120,

  // ---- sign-in ----
  // The entry URL. When cookies are still valid this lands straight on the chat page.
  LOGIN_URL: process.env.COPILOT_LOGIN_URL ?? 'https://copilot.cloud.microsoft',
  // Host whose WebSocket carries the access_token in its query string.
  CHATHUB_WS_HOST: process.env.COPILOT_CHATHUB_WS_HOST ?? 'substrate.office.com',
  // COPILOT_HEADLESS=1 runs sign-in headless; the default shows the browser (more reliable).
  HEADLESS: process.env.COPILOT_HEADLESS === '1',

  // ---- client-side (browser-extension) session capture ----
  // The extension POSTs a captured Copilot session to /api/auth/client. When this key is set, that
  // request must carry it in an x-client-key header; leave unset to trust the local network.
  CLIENT_CAPTURE_KEY: process.env.COPILOT_CLIENT_KEY ?? '',
  // COPILOT_BROWSER_SIGNIN=0 disables the server-side Playwright sign-in. With no captured session,
  // /api/auth/login then fails with a clear message instead of launching Chromium.
  BROWSER_SIGNIN_ENABLED: process.env.COPILOT_BROWSER_SIGNIN !== '0',
  LOGIN_STEP_TIMEOUT_MS: 60_000,
  TOKEN_CAPTURE_TIMEOUT_MS: 60_000,
  // A sign-in attempt left waiting on the person (password or code screen) is closed after this long,
  // so an abandoned attempt cannot keep a Chromium open on the server indefinitely.
  LOGIN_IDLE_TIMEOUT_MS: 5 * 60_000,
  LOGIN_IDLE_CHECK_INTERVAL_MS: 60_000,
  // Every sign-in is a whole Chromium. Raise COPILOT_MAX_LOGINS only if the server has the memory for it.
  MAX_CONCURRENT_LOGINS: Number(process.env.COPILOT_MAX_LOGINS) || 2,

  // ---- chat-history (delete) over the _serverFn endpoint ----
  // Deleting a conversation is a serverFn call on copilot.cloud.microsoft, not a Chathub WebSocket
  // message. The route hash (serverFnIdHash) identifies the "chat-history" server function and can
  // change between Copilot builds; override via COPILOT_SERVERFN_HASH if it ever 404s.
  COPILOT_BASE_URL: 'https://copilot.cloud.microsoft',
  SERVERFN_HASH: process.env.COPILOT_SERVERFN_HASH ?? '73e9366cfbebe3976abc796ef16c0305213fd6f32aea4731837e2a1f18e54268',
  SERVERFN_HOST_CONTEXT: process.env.COPILOT_SERVERFN_HOST_CONTEXT ?? '{"clientPlatform":"web","hostName":"officeweb","appMode":"default"}',
  // Fallback x-client-eligibility for serverFn calls; the live value captured at sign-in wins.
  SERVERFN_CLIENT_ELIGIBILITY: process.env.COPILOT_SERVERFN_CLIENT_ELIGIBILITY ?? '{"isCopilotEligible":true,"cohort":"bcwaf","persona":"none","ageGroup":"none","isCopilotEnabledRegion":true,"isOptedOutByAdmin":false,"eduType":"none","isError":false,"m365CopilotAcquisitionState":"acquired","acquisitionState":"acquired","featureSet":{"uxFeatures":["CodeInterpreter","Designer","GPTV","Threads","WebGroundingControls","Pages","FileUpload"],"serverFeatures":[]},"windowsAILearningStartDate":"1970-01-01T00:00:00Z","CopilotBlockedCustomLink":"","isConsumptiveServicesDiscoverable":"false","accessToUsageBasedBilling":"true","shareSetting":"Confidential","hasAdminLedRoutingRules":false,"copilotAdminPinSetting":"Pinned"}',

  // ---- file uploads (attachments Copilot can actually read) ----
  // The Chathub chat token has no Files scope, so uploads go through Graph using the M365Chat
  // client's own refresh token (captured from MSAL at sign-in). Values copied from the browser.
  UPLOAD_CLIENT_ID: 'c0ab8ce9-e9a0-42e7-b064-33d422df41f1',
  UPLOAD_REDIRECT_URI: 'brk-multihub://outlook.office.com',
  GRAPH_BASE_URL: 'https://graph.microsoft.com/v1.0',
  LOGIN_AUTHORITY: 'https://login.microsoftonline.com',
  // Copilot's upload folder is the "copilotuploads" special folder (→ "Microsoft Copilot Chat Files").
  UPLOAD_FOLDER_PATH: 'copilotuploads',
  MAX_UPLOAD_BYTES: Number(process.env.COPILOT_MAX_UPLOAD_BYTES) || 100 * 1024 * 1024,
  GRAPH_TOKEN_EXPIRY_SKEW_SECONDS: 120,

  SESSION_COOKIE_NAME: 'cp_session',
  SESSION_TTL_MS: 30 * 24 * 60 * 60 * 1000,

  SIGNALR_RECORD_SEPARATOR: '\x1e',
  SIGNALR_TYPE_UPDATE: 1,
  SIGNALR_TYPE_COMPLETION: 2,
  SIGNALR_TYPE_STREAM_COMPLETION: 3,
  SIGNALR_TYPE_INVOCATION: 4,
  SIGNALR_TYPE_PING: 6,
  SIGNALR_TYPE_CLOSE: 7,

  CLIENT_INFO,
  OPTIONS_SETS,
  ALLOWED_MESSAGE_TYPES,
  ENTITY_ANNOTATION_TYPES: Object.freeze(['People', 'File', 'Event', 'Email', 'TeamsMessage']),
});
