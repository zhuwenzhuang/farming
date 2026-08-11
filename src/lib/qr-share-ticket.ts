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

export interface ReadOnlyShareLink {
  url: string
  expiresAt: number
  revokeUnusedTicket: () => Promise<void>
}

export async function requestReadOnlyShareLink(
  target: WorkspaceShareTarget,
  failureMessage: string,
): Promise<ReadOnlyShareLink> {
  const response = await fetch(appPath('/api/share/qr-ticket'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target }),
  })
  const body = await response.json().catch(() => null)
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : null
  const url = nonEmptyString(record?.longUrl)
  const code = nonEmptyString(record?.code)
  const expiresAt = Number(record?.expiresAt)
  if (
    !response.ok
    || !url
    || !code
    || record?.longUrlAccessMode !== 'read-only'
    || !Number.isFinite(expiresAt)
  ) {
    throw new Error(nonEmptyString(record?.error) ?? failureMessage)
  }
  return {
    url,
    expiresAt,
    revokeUnusedTicket: async () => {
      await fetch(appPath(`/api/share/qr-ticket/${encodeURIComponent(code)}`), { method: 'DELETE' })
        .catch(() => {})
    },
  }
}
