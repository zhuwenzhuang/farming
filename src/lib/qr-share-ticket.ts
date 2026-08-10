import { appPath } from './base-path'
import type { WorkspaceShareTarget } from './workspace-share-target'

type QrShareTicketRequest = (
  url: string,
  init: { method: 'POST'; headers: { 'Content-Type': 'application/json' }; body: string },
) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
}>

function nonEmptyString(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

export async function requestQrShareTicket(
  target: WorkspaceShareTarget | null | undefined,
  failureMessage: string,
  request: QrShareTicketRequest = fetch,
) {
  const response = await request(appPath('/api/share/qr-ticket'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(target ? { target } : {}),
  })
  const body = await response.json().catch(() => null)
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : null
  const longUrl = nonEmptyString(record?.longUrl)
  const shortUrl = nonEmptyString(record?.shortUrl)
  if (!response.ok || (!longUrl && !shortUrl)) {
    throw new Error(nonEmptyString(record?.error) ?? failureMessage)
  }
  return longUrl ?? shortUrl!
}
