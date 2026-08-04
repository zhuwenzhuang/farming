type SessionPreviewScope = 'all' | 'focused' | 'none';

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

export {
  normalizeSessionPreviewScope,
  sessionPreviewScopeCheckpointRequired,
  sessionPreviewScopeIncludesAgent,
};

export type { SessionPreviewScope };
