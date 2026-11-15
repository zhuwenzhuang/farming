/** Live ACP feedback. IDs belong to the client runtime, not the provider. */
export interface AcpNotice {
  id: string
  severity: string
  title: string
  description?: string
  _meta?: Record<string, unknown>
}
