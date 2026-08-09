import { useCallback, useEffect, useRef, useState } from 'react'
import { appPath } from '@/lib/base-path'
import type { WorkspaceShareTarget } from '@/lib/workspace-share-target'
import { LatestRequestFence } from './latest-request-fence'

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

export interface QrSharePorts {
  createTicket: (target: WorkspaceShareTarget | null | undefined) => Promise<string>
  publishUrl: (url: string) => void
  failureMessage: () => string
  reportError: (message: string) => void
}

/**
 * Owns share-ticket request admission and the published URL for one view.
 *
 * Only the newest request may publish a URL or report a failure. Clearing and
 * disposing revoke every in-flight request, so closing the sheet cannot be
 * undone by a late success or error. A ticket is a mutation with an uncertain
 * outcome: a transport failure is reported once and never replayed.
 */
export class QrShareLifecycle {
  private readonly fence = new LatestRequestFence()

  constructor(private readonly ports: QrSharePorts) {}

  create(target: WorkspaceShareTarget | null | undefined) {
    const lease = this.fence.begin()
    this.ports.createTicket(target)
      .then(url => {
        if (!lease.isCurrent()) return
        this.ports.publishUrl(url)
      })
      .catch(error => {
        if (!lease.isCurrent()) return
        if (error instanceof DOMException && error.name === 'AbortError') return
        this.ports.reportError(error instanceof Error ? error.message : this.ports.failureMessage())
      })
  }

  clear() {
    this.fence.invalidate()
    this.ports.publishUrl('')
  }

  dispose() {
    this.fence.invalidate()
  }
}

export interface QrShareControllerOptions {
  failureMessage: string
  onError: (message: string) => void
}

export function useQrShareController({ failureMessage, onError }: QrShareControllerOptions) {
  const [url, setUrl] = useState('')
  const failureMessageRef = useRef(failureMessage)
  failureMessageRef.current = failureMessage
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  const lifecycleRef = useRef<QrShareLifecycle | null>(null)
  if (lifecycleRef.current === null) {
    lifecycleRef.current = new QrShareLifecycle({
      createTicket: target => requestQrShareTicket(target, failureMessageRef.current),
      publishUrl: setUrl,
      failureMessage: () => failureMessageRef.current,
      reportError: message => onErrorRef.current(message),
    })
  }
  const lifecycle = lifecycleRef.current

  useEffect(() => () => {
    lifecycle.dispose()
  }, [lifecycle])

  const create = useCallback((target: WorkspaceShareTarget | null | undefined) => {
    lifecycle.create(target)
  }, [lifecycle])

  const clear = useCallback(() => {
    lifecycle.clear()
  }, [lifecycle])

  return { url, create, clear }
}
