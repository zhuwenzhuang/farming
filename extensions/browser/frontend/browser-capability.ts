import type { BrowserCapability } from './types'

export function browserCapabilityForClient(
  capability: BrowserCapability,
  desktopNativeBrowser: boolean,
): BrowserCapability {
  if (!capability.sources?.length) return capability
  const source = desktopNativeBrowser ? 'desktop' : capability.selection?.source
  if (!source) return capability
  const available = capability.enabled === true
    && capability.sources.some(candidate => candidate.source === source && candidate.available === true)
  return available === capability.available ? capability : { ...capability, available }
}
