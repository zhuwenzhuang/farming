// Chat is a product-level intent. The concrete runtime remains provider-owned:
// Codex needs its App Server turn protocol, while other coding agents use ACP.
const CHAT_MODE = 'chat';

function chatRuntimeForProvider(provider) {
  return String(provider || '').trim().toLowerCase() === 'codex'
    ? 'app-server'
    : 'acp';
}

function isChatMode(mode) {
  return mode === CHAT_MODE;
}

function chatCapabilitiesForProvider(provider) {
  const runtime = chatRuntimeForProvider(provider);
  return {
    chatRuntime: runtime,
    supportsChat: true,
    // ACP does not define a turn-versioned steer operation. Do not make this
    // look generic just because both runtimes render in the same Chat UI.
    supportsSteer: runtime === 'app-server',
  };
}

module.exports = {
  CHAT_MODE,
  chatRuntimeForProvider,
  chatCapabilitiesForProvider,
  isChatMode,
};
