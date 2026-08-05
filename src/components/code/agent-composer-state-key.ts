export function existingComposerStateUpdateKey(
  states: Record<string, unknown>,
  canonicalKey: string,
  requestedKey: string,
) {
  if (states[canonicalKey]) return canonicalKey
  if (states[requestedKey]) return requestedKey
  return canonicalKey
}
