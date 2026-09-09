import { useEffect, useRef, useState } from 'react'
import type { MermaidConfig, MermaidDiagram, MermaidRenderer } from '@/lib/mermaid-renderer'
import type { PendingRichContent } from '@/lib/streaming-markdown'

type RenderState = {
  status: 'loading' | 'ready' | 'error' | 'streaming' | 'interrupted'
  diagram?: MermaidDiagram
  message?: string
}

type Request = {
  source: string
  id: string
  config: MermaidConfig
  renderer: MermaidRenderer
  pending?: PendingRichContent
}

// One running request and one latest desired revision per block. Retain the
// previous diagram during repaint; obsolete results never replace new content.
export function useMermaidRender(request: Request): RenderState {
  const [state, setState] = useState<RenderState>({ status: request.pending || 'loading' })
  const { source, id, config, renderer, pending } = request
  const cancelRef = useRef<(() => void) | undefined>(undefined)
  const desired = useRef<Request | null>(null)
  const running = useRef(false)
  useEffect(() => () => { desired.current = null; cancelRef.current?.() }, [])
  useEffect(() => {
    const request = { source, id, config, renderer, pending }
    desired.current = request
    setState(previous => ({ ...previous, status: request.pending || 'loading', message: undefined }))
    const run = () => {
      const next = desired.current
      if (!next || next.pending || running.current) return
      running.current = true
      let active = true
      const current = () => active && desired.current === next
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_, reject) => {
        cancelRef.current = () => { active = false; clearTimeout(timer); reject(new Error('Diagram viewer closed')) }
        timer = setTimeout(() => reject(new Error('Diagram rendering timed out. Retry to render it again.')), 15_000)
      })
      void Promise.race([next.renderer(next.id, next.source, next.config, current), timeout])
        .then(diagram => {
          if (current()) setState({ status: 'ready', diagram })
        }, error => {
          if (current()) setState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
        })
        .finally(() => {
          clearTimeout(timer)
          active = false
          cancelRef.current = undefined
          running.current = false
          if (desired.current !== next) run()
        })
    }
    run()
    return () => { if (desired.current === request) desired.current = null }
  }, [source, id, config, renderer, pending])
  return state
}
