import { requestTerminalFenceReconciliation } from '@/lib/terminal-session-client'

export {
  requestTerminalSessionCheckpoint,
  setTerminalSessionTransport,
  setTerminalSessionTransportReady,
  settleTerminalSessionCheckpoint,
} from '@/lib/terminal-session-client'

/**
 * Visible terminal input errors that warrant an explicit viewer-observed
 * reconciliation. `uncertain-input-fence` rejects a later input against an
 * active fence; `delivery-not-confirmed` is the first visible sign of the
 * uncertain write that activated the fence, so reconciling on it recovers
 * the attached session without a sacrificial second input. Neither label
 * claims the write was a proven rejection.
 */
const RECONCILIATION_WORTHY_REASONS: ReadonlySet<string> = new Set([
  'uncertain-input-fence',
  'delivery-not-confirmed',
])

/**
 * Production decision for a server terminal input error: when the error
 * identifies an Agent and a reconciliation-worthy reason, drive the bounded
 * explicit checkpoint request for that exact Agent. Returns whether a
 * reconciliation was driven (the request itself stays deduped to one
 * in-flight per Agent inside the terminal session client).
 */
export function reconcileTerminalFenceError(error: {
  agentId?: unknown
  reason?: unknown
}): boolean {
  const reason = typeof error.reason === 'string' ? error.reason : ''
  const agentId = typeof error.agentId === 'string' ? error.agentId : ''
  if (!agentId || !RECONCILIATION_WORTHY_REASONS.has(reason)) return false
  requestTerminalFenceReconciliation(agentId)
  return true
}
