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

type QrShareTicketRevoke = (
  url: string,
  init: { method: 'DELETE' },
) => Promise<unknown>

function nonEmptyString(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

interface QrShareTicketBase {
  code: string
  expiresAt: number
  ttlMs: number
  shortPath: string
  shortUrl: string
  longUrl: string
  longUrlAccessMode: 'read-only'
}

export type QrShareTicket = QrShareTicketBase & (
  | {
    shortUrlAccessMode: 'owner'
    fullAccessUrl: string
    tokenLabel: string
  }
  | {
    shortUrlAccessMode: 'read-only'
    fullAccessUrl?: undefined
    tokenLabel: ''
  }
)

export interface RotatedOwnerCredential {
  fullAccessUrl: string
  tokenLabel: string
}

export async function requestQrShareTicket(
  target: WorkspaceShareTarget | null | undefined,
  failureMessage: string,
  request: QrShareTicketRequest = fetch,
): Promise<QrShareTicket> {
  const response = await request(appPath('/api/share/qr-ticket'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(target ? { target } : {}),
  })
  const body = await response.json().catch(() => null)
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : null
  const longUrl = nonEmptyString(record?.longUrl)
  const shortUrl = nonEmptyString(record?.shortUrl)
  const code = nonEmptyString(record?.code)
  const shortPath = nonEmptyString(record?.shortPath)
  const expiresAt = Number(record?.expiresAt)
  const ttlMs = Number(record?.ttlMs)
  const shortUrlAccessMode = record?.shortUrlAccessMode
  const fullAccessUrl = nonEmptyString(record?.fullAccessUrl)
  const tokenLabel = nonEmptyString(record?.tokenLabel)
  const commonFieldsValid = response.ok
    && Boolean(longUrl)
    && Boolean(shortUrl)
    && Boolean(code)
    && Boolean(shortPath)
    && Number.isFinite(expiresAt)
    && Number.isFinite(ttlMs)
    && record?.longUrlAccessMode === 'read-only'
  const accessFieldsValid = shortUrlAccessMode === 'owner'
    ? Boolean(fullAccessUrl && tokenLabel)
    : shortUrlAccessMode === 'read-only' && !fullAccessUrl && !tokenLabel
  if (!commonFieldsValid || !accessFieldsValid) {
    throw new Error(nonEmptyString(record?.error) ?? failureMessage)
  }
  const ticket = {
    code: code!,
    expiresAt,
    ttlMs,
    shortPath: shortPath!,
    shortUrl: shortUrl!,
    longUrl: longUrl!,
    longUrlAccessMode: 'read-only' as const,
  }
  return shortUrlAccessMode === 'owner'
    ? { ...ticket, shortUrlAccessMode, fullAccessUrl: fullAccessUrl!, tokenLabel: tokenLabel! }
    : { ...ticket, shortUrlAccessMode: 'read-only', tokenLabel: '' }
}

export async function revokeQrShareTicket(
  ticket: Pick<QrShareTicket, 'code'> | null | undefined,
  request: QrShareTicketRevoke = fetch,
) {
  if (!ticket?.code) return
  await request(appPath(`/api/share/qr-ticket/${encodeURIComponent(ticket.code)}`), { method: 'DELETE' })
    .catch(() => {})
}

export async function requestOwnerTokenRotation(
  target: WorkspaceShareTarget | null | undefined,
  failureMessage: string,
  request: QrShareTicketRequest = fetch,
): Promise<RotatedOwnerCredential> {
  const response = await request(appPath('/api/share/qr-ticket/rotate'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(target ? { target } : {}),
  })
  const body = await response.json().catch(() => null)
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : null
  const fullAccessUrl = nonEmptyString(record?.fullAccessUrl)
  const tokenLabel = nonEmptyString(record?.tokenLabel)
  if (!response.ok || !fullAccessUrl || !tokenLabel) {
    throw new Error(nonEmptyString(record?.error) ?? failureMessage)
  }
  return { fullAccessUrl, tokenLabel }
}

export function ownerUrlWithRotatedToken(currentUrl: string, token: string) {
  const nextUrl = new URL(currentUrl)
  nextUrl.searchParams.set('token', token)
  return nextUrl.href
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
    revokeUnusedTicket: () => revokeQrShareTicket({ code }),
  }
}
