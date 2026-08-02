export function codexRealtimeVoiceAvailable(
  protocolNegotiated: boolean,
  runtimeAdvertised: boolean,
): boolean {
  return protocolNegotiated && runtimeAdvertised
}
