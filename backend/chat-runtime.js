// Chat is a product-level intent. ACP is the single structured Chat runtime for
// every supported coding agent, including Codex.
const CHAT_MODE = 'chat';

function chatRuntimeForProvider() {
  return 'acp';
}

function isChatMode(mode) {
  return mode === CHAT_MODE;
}

function chatCapabilitiesForProvider(provider) {
  const runtime = chatRuntimeForProvider(provider);
  return {
    chatRuntime: runtime,
    supportsChat: true,
    // ACP does not currently define a turn-versioned steer operation.
    supportsSteer: false,
  };
}

module.exports = {
  CHAT_MODE,
  chatRuntimeForProvider,
  chatCapabilitiesForProvider,
  isChatMode,
};
