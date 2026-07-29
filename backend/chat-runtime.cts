// Chat is a product-level intent. ACP is the single structured Chat runtime for
// every supported coding agent, including Codex.
const CHAT_MODE = 'chat' as const;

interface ChatCapabilities {
  chatRuntime: 'acp';
  supportsChat: true;
  supportsSteer: false;
}

function chatRuntimeForProvider(_provider: unknown): 'acp' {
  return 'acp';
}

function isChatMode(mode: unknown): mode is typeof CHAT_MODE {
  return mode === CHAT_MODE;
}

function chatCapabilitiesForProvider(provider: unknown): ChatCapabilities {
  const runtime = chatRuntimeForProvider(provider);
  return {
    chatRuntime: runtime,
    supportsChat: true,
    // ACP does not currently define a turn-versioned steer operation.
    supportsSteer: false,
  };
}

export {
  CHAT_MODE,
  chatRuntimeForProvider,
  chatCapabilitiesForProvider,
  isChatMode,
};
