import { useEffect, useMemo, useState } from 'react'
import { BackToAgentGlyph, SquareGlyph } from '@/components/IconGlyphs'
import { appPath } from '@/lib/base-path'
import type { UiPreferences } from '@/lib/ui-preferences'
import type { ComputerResource } from './types'
import type { ComputerResourcesController } from './useComputerResources'

function copyFor(language: UiPreferences['language']) {
  const zh = language === 'zh'
  return {
    back: zh ? '返回 Agent' : 'Back to Agent',
    takeControl: zh ? '接管' : 'Take control',
    returnControl: zh ? '交还 Agent' : 'Return to Agent',
    stop: zh ? '停止' : 'Stop',
    start: zh ? '启动电脑' : 'Start Computer',
    agentControls: zh ? 'Agent 正在控制；当前为只读观察。' : 'The Agent controls this Computer; the Viewer is read-only.',
    humanControls: zh ? '你正在控制这台电脑。' : 'You control this Computer.',
    stopped: zh ? '电脑已停止' : 'Computer stopped',
    failed: zh ? '电脑启动失败' : 'Computer failed',
    viewerFailed: zh ? 'Computer Viewer 加载失败' : 'Computer Viewer failed',
  }
}

type ViewerConfig = {
  password: string
  viewOnly: boolean
  generation: number
  controlEpoch: number
}

async function viewerConfig(resource: ComputerResource): Promise<ViewerConfig> {
  const response = await fetch(appPath(`/api/computers/${encodeURIComponent(resource.id)}/viewer-config`), {
    headers: { Accept: 'application/json' },
  })
  const data = await response.json().catch(() => ({})) as ViewerConfig & { error?: string }
  if (!response.ok) throw new Error(data.error || `Computer Viewer failed (${response.status})`)
  return data
}

function viewerUrl(resource: ComputerResource, config: ViewerConfig) {
  const path = appPath(`/api/computers/${encodeURIComponent(resource.id)}/viewer-websocket`)
    .replace(/^\/+/, '')
  const url = new URL(
    appPath(`/api/computers/${encodeURIComponent(resource.id)}/viewer/vnc.html`),
    window.location.href,
  )
  url.searchParams.set('autoconnect', '1')
  url.searchParams.set('resize', 'scale')
  url.searchParams.set('shared', '1')
  url.searchParams.set('view_only', config.viewOnly ? '1' : '0')
  url.searchParams.set('password', config.password)
  url.searchParams.set('path', path)
  return url.href
}

export function ComputerViewer({
  resource,
  controller,
  language,
  onBackToAgent,
}: {
  resource: ComputerResource
  controller: ComputerResourcesController
  language: UiPreferences['language']
  onBackToAgent: () => void
}) {
  const copy = copyFor(language)
  const [config, setConfig] = useState<ViewerConfig | null>(null)
  const [error, setError] = useState('')
  const busy = resource.status === 'starting' || resource.status === 'stopping'

  useEffect(() => {
    if (resource.status !== 'running') {
      setConfig(null)
      setError('')
      return
    }
    let active = true
    void viewerConfig(resource).then(next => {
      if (!active) return
      setConfig(next)
      setError('')
    }).catch(caught => {
      if (active) setError(caught instanceof Error ? caught.message : copy.viewerFailed)
    })
    return () => {
      active = false
    }
  }, [
    copy.viewerFailed,
    resource.controlEpoch,
    resource.generation,
    resource.id,
    resource.status,
  ])

  const src = useMemo(
    () => config ? viewerUrl(resource, config) : '',
    [config, resource],
  )
  const toggleControl = async () => {
    await controller.takeControl(
      resource.id,
      resource.controlOwner === 'human' ? 'agent' : 'human',
    )
  }

  return (
    <section className="farming-computer-viewer" data-testid="farming-computer-viewer">
      <header className="farming-computer-toolbar">
        <button type="button" title={copy.back} aria-label={copy.back} onClick={onBackToAgent}>
          <BackToAgentGlyph />
        </button>
        <span className="farming-computer-toolbar-title">{resource.name}</span>
        {resource.status === 'running' && (
          <>
            <span className={`farming-computer-control-status ${resource.controlOwner}`}>
              {resource.controlOwner === 'human' ? copy.humanControls : copy.agentControls}
            </span>
            <button
              type="button"
              className="farming-computer-control-button"
              onClick={() => void toggleControl()}
            >
              {resource.controlOwner === 'human' ? copy.returnControl : copy.takeControl}
            </button>
            <button
              type="button"
              title={copy.stop}
              aria-label={copy.stop}
              onClick={() => void controller.stop(resource.id)}
            >
              <SquareGlyph />
            </button>
          </>
        )}
      </header>
      <div className="farming-computer-viewport">
        {resource.status === 'running' && src ? (
          <iframe
            key={`${resource.generation}:${resource.controlEpoch}`}
            src={src}
            title={resource.name}
            allow="clipboard-read; clipboard-write"
          />
        ) : resource.status === 'failed' ? (
          <div className="farming-computer-empty-state">
            <strong>{copy.failed}</strong>
            <span>{resource.error}</span>
            <button type="button" disabled={busy} onClick={() => void controller.start(resource.id)}>
              {copy.start}
            </button>
          </div>
        ) : (
          <div className="farming-computer-empty-state">
            <strong>{copy.stopped}</strong>
            <button type="button" disabled={busy} onClick={() => void controller.start(resource.id)}>
              {copy.start}
            </button>
          </div>
        )}
        {error && <div className="farming-computer-error">{error}</div>}
      </div>
    </section>
  )
}
