type SessionPreviewScope = 'all' | 'focused' | 'none';

interface SessionPreviewHydrationState {
  previewHydrationPending?: boolean;
  previewHydrationTimer?: ReturnType<typeof setTimeout> | null;
  previewScopeDeclared?: boolean;
}

function normalizeSessionPreviewScope(scope: unknown): SessionPreviewScope {
  return scope === 'none' || scope === 'focused' || scope === 'all'
    ? scope
    : 'all';
}

function sessionPreviewScopeIncludesAgent(
  scope: SessionPreviewScope | null | undefined,
  focusedAgentId: string | null | undefined,
  previewAgentId: string,
): boolean {
  const normalizedScope = normalizeSessionPreviewScope(scope);
  if (normalizedScope === 'none') return false;
  return normalizedScope !== 'focused' || focusedAgentId === previewAgentId;
}

function sessionPreviewScopeCheckpointRequired(
  previousScope: SessionPreviewScope,
  previousFocusedAgentId: string | null | undefined,
  nextScope: SessionPreviewScope,
  nextFocusedAgentId: string | null | undefined,
): boolean {
  if (nextScope === 'none' || previousScope === 'all') return false;
  if (nextScope === 'all') return true;
  return previousScope !== 'focused' || previousFocusedAgentId !== nextFocusedAgentId;
}

function cancelSessionPreviewHydration(state: SessionPreviewHydrationState) {
  if (state.previewHydrationTimer) clearTimeout(state.previewHydrationTimer);
  state.previewHydrationTimer = null;
  state.previewHydrationPending = false;
}

function declareSessionPreviewScope(state: SessionPreviewHydrationState) {
  const hydrationPending = state.previewHydrationPending === true;
  state.previewScopeDeclared = true;
  cancelSessionPreviewHydration(state);
  return hydrationPending;
}

function queueSessionPreviewHydration(
  state: SessionPreviewHydrationState,
  delayMs: number,
  hydrate: () => void,
) {
  if (state.previewScopeDeclared === true) {
    cancelSessionPreviewHydration(state);
    hydrate();
    return;
  }
  state.previewHydrationPending = true;
  if (state.previewHydrationTimer) return;
  state.previewHydrationTimer = setTimeout(() => {
    state.previewHydrationTimer = null;
    if (state.previewHydrationPending !== true) return;
    state.previewHydrationPending = false;
    hydrate();
  }, Math.max(0, delayMs));
  state.previewHydrationTimer.unref?.();
}

export {
  cancelSessionPreviewHydration,
  declareSessionPreviewScope,
  normalizeSessionPreviewScope,
  queueSessionPreviewHydration,
  sessionPreviewScopeCheckpointRequired,
  sessionPreviewScopeIncludesAgent,
};

export type { SessionPreviewHydrationState, SessionPreviewScope };
