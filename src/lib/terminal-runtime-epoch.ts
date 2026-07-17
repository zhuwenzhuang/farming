const RUNTIME_EPOCH_PATTERN = /^farming-runtime-v1:(\d{20}):/

export function terminalRuntimeEpochGeneration(runtimeEpoch: string): number | null {
  const match = RUNTIME_EPOCH_PATTERN.exec(String(runtimeEpoch || ''))
  if (!match) return null
  const generation = Number(match[1])
  return Number.isSafeInteger(generation) && generation > 0 ? generation : null
}

export function compareTerminalRuntimeEpochs(left: string, right: string): number | null {
  if (left === right) return 0
  const leftGeneration = terminalRuntimeEpochGeneration(left)
  const rightGeneration = terminalRuntimeEpochGeneration(right)
  if (leftGeneration === null || rightGeneration === null) return null
  if (leftGeneration === rightGeneration) return null
  return leftGeneration < rightGeneration ? -1 : 1
}
