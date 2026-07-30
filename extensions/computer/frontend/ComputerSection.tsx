import { useState } from 'react'
import {
  ChevronDownGlyph,
  ChevronRightGlyph,
  CloseGlyph,
  PencilGlyph,
  PlusGlyph,
  SquareGlyph,
} from '@/components/IconGlyphs'
import type { UiPreferences } from '@/lib/ui-preferences'
import type { ComputerResource } from './types'
import type { ComputerResourcesController } from './useComputerResources'

function copyFor(language: UiPreferences['language']) {
  const zh = language === 'zh'
  return {
    title: zh ? '桌面' : 'Desktops',
    create: zh ? '创建隔离桌面' : 'Create Isolated Desktop',
    start: zh ? '启动桌面' : 'Start Desktop',
    stop: zh ? '停止桌面' : 'Stop Desktop',
    remove: zh ? '删除桌面' : 'Delete Desktop',
    rename: zh ? '重命名桌面' : 'Rename Desktop',
    name: zh ? '桌面名称' : 'Desktop name',
    stopped: zh ? '已停止' : 'Stopped',
    starting: zh ? '启动中…' : 'Starting…',
    stopping: zh ? '停止中…' : 'Stopping…',
    failed: zh ? '启动失败' : 'Failed',
    humanControl: zh ? '由你控制' : 'Human control',
    agentControl: zh ? '由 Agent 控制' : 'Agent control',
  }
}

function PlayGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.5 2.6a.75.75 0 0 1 1.15-.63l7 4.9a.75.75 0 0 1 0 1.23l-7 4.9A.75.75 0 0 1 4.5 12.4V2.6Z" />
    </svg>
  )
}

export function ComputerSection({
  workspace,
  agentId,
  resource,
  active,
  controller,
  language,
  collapsed,
  onToggle,
  onOpen,
}: {
  workspace: string
  agentId: string
  resource: ComputerResource | null
  active: boolean
  controller: ComputerResourcesController
  language: UiPreferences['language']
  collapsed: boolean
  onToggle: () => void
  onOpen: (resource: ComputerResource) => void
}) {
  const copy = copyFor(language)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(resource?.name || 'Desktop')
  const create = async () => {
    const created = await controller.create(workspace, agentId)
    const running = await controller.start(created.id)
    onOpen(running)
  }
  const detail = resource?.status === 'failed'
    ? resource.error || copy.failed
    : resource?.status === 'starting'
      ? copy.starting
      : resource?.status === 'stopping'
        ? copy.stopping
        : resource?.status === 'running'
          ? resource.controlOwner === 'human'
            ? copy.humanControl
            : copy.agentControl
          : copy.stopped
  return (
    <section className="farming-computer-section" data-testid="farming-computer-section">
      <header>
        <button
          type="button"
          className="farming-computer-section-toggle"
          aria-expanded={!collapsed}
          onClick={onToggle}
        >
          <span aria-hidden="true">{collapsed ? <ChevronRightGlyph /> : <ChevronDownGlyph />}</span>
          <span>{copy.title}</span>
          {resource && <small>1</small>}
        </button>
        {!resource && (
          <button type="button" title={copy.create} aria-label={copy.create} onClick={() => void create()}>
            <PlusGlyph />
          </button>
        )}
      </header>
      {!collapsed && (
        resource ? (
          <div
            className={`farming-computer-row ${active ? 'active' : ''}`}
            data-testid="farming-computer-row"
            role="button"
            tabIndex={0}
            onClick={() => onOpen(resource)}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') onOpen(resource)
            }}
          >
            <span className={`farming-computer-status ${resource.status}`} />
            <span className="farming-computer-copy">
              {renaming ? (
                <input
                  autoFocus
                  value={name}
                  aria-label={copy.name}
                  onClick={event => event.stopPropagation()}
                  onChange={event => setName(event.currentTarget.value)}
                  onBlur={() => {
                    setRenaming(false)
                    if (name.trim() && name.trim() !== resource.name) {
                      void controller.rename(resource.id, name.trim())
                    }
                  }}
                />
              ) : <span className="farming-computer-name">{resource.name}</span>}
              <span className="farming-computer-detail" title={resource.error}>{detail}</span>
            </span>
            <span className="farming-computer-actions">
              <button
                type="button"
                title={copy.rename}
                aria-label={copy.rename}
                onClick={event => {
                  event.stopPropagation()
                  setName(resource.name)
                  setRenaming(true)
                }}
              >
                <PencilGlyph />
              </button>
              <button
                type="button"
                title={resource.status === 'running' ? copy.stop : copy.start}
                aria-label={resource.status === 'running' ? copy.stop : copy.start}
                disabled={resource.status === 'starting' || resource.status === 'stopping'}
                onClick={event => {
                  event.stopPropagation()
                  const transition = resource.status === 'running'
                    ? controller.stop(resource.id)
                    : controller.start(resource.id)
                  void transition
                }}
              >
                {resource.status === 'running' ? <SquareGlyph /> : <PlayGlyph />}
              </button>
              <button
                type="button"
                title={copy.remove}
                aria-label={copy.remove}
                onClick={event => {
                  event.stopPropagation()
                  void controller.remove(resource.id)
                }}
              >
                <CloseGlyph />
              </button>
            </span>
          </div>
        ) : (
          <button type="button" className="farming-computer-empty" onClick={() => void create()}>
            <PlusGlyph />
            <span>{copy.create}</span>
          </button>
        )
      )}
    </section>
  )
}
