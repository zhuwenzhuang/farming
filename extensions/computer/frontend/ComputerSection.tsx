import { useEffect, useRef, useState } from 'react'
import {
  ChevronDownGlyph,
  ChevronRightGlyph,
  DesktopGlyph,
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
    createFailed: zh ? '隔离桌面创建失败' : 'Failed to create Isolated Desktop',
    start: zh ? '启动桌面' : 'Start Desktop',
    stop: zh ? '停止桌面' : 'Stop Desktop',
    remove: zh ? '删除桌面' : 'Delete Desktop',
    removeConfirm: (name: string) => zh
      ? `删除“${name}”及其隔离环境？此操作无法撤销。`
      : `Delete “${name}” and its isolated environment? This cannot be undone.`,
    rename: zh ? '重命名桌面' : 'Rename Desktop',
    more: zh ? '更多' : 'More',
    name: zh ? '桌面名称' : 'Desktop name',
    stopped: zh ? '已停止' : 'Stopped',
    starting: zh ? '启动中…' : 'Starting…',
    stopping: zh ? '停止中…' : 'Stopping…',
    removing: zh ? '删除中…' : 'Deleting…',
    failed: zh ? '启动失败' : 'Failed',
    humanControl: zh ? '由你控制' : 'Human control',
    agentControl: zh ? '由 Agent 控制' : 'Agent control',
    browserInUse: (count: number) => zh
      ? `${count} 个浏览器正在使用`
      : `${count} browser${count === 1 ? '' : 's'} in use`,
    stopBrowsersFirst: zh ? '请先停止正在使用此桌面的浏览器' : 'Stop the Browsers using this Desktop first',
    renameFailed: zh ? '桌面重命名失败' : 'Desktop rename failed',
    transitionFailed: zh ? '桌面状态切换失败' : 'Desktop transition failed',
    deleteFailed: zh ? '桌面删除失败' : 'Desktop deletion failed',
  }
}

function PlayGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.5 2.6a.75.75 0 0 1 1.15-.63l7 4.9a.75.75 0 0 1 0 1.23l-7 4.9A.75.75 0 0 1 4.5 12.4V2.6Z" />
    </svg>
  )
}

function MoreGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="3" cy="8" r="1.1" />
      <circle cx="8" cy="8" r="1.1" />
      <circle cx="13" cy="8" r="1.1" />
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
  isolatedBrowserCount,
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
  isolatedBrowserCount: number
  onToggle: () => void
  onOpen: (resource: ComputerResource) => void
}) {
  const copy = copyFor(language)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(resource?.name || 'Desktop')
  const [moreOpen, setMoreOpen] = useState(false)
  const [operation, setOperation] = useState<'start' | 'stop' | 'remove' | null>(null)
  const [operationError, setOperationError] = useState('')
  const moreButtonRef = useRef<HTMLButtonElement>(null)
  const moreMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!moreOpen) return undefined
    const close = (event: PointerEvent) => {
      if (
        event.target instanceof Node
        && (moreButtonRef.current?.contains(event.target) || moreMenuRef.current?.contains(event.target))
      ) return
      setMoreOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setMoreOpen(false)
      moreButtonRef.current?.focus()
    }
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('keydown', closeOnEscape, true)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('keydown', closeOnEscape, true)
    }
  }, [moreOpen])

  const create = async () => {
    try {
      const created = await controller.create(workspace, agentId)
      const running = await controller.start(created.id)
      onOpen(running)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : copy.createFailed)
    }
  }
  const runOperation = async (kind: 'start' | 'stop' | 'remove') => {
    if (!resource || operation) return
    setOperation(kind)
    setOperationError('')
    try {
      if (kind === 'remove') await controller.remove(resource.id)
      else if (kind === 'start') await controller.start(resource.id)
      else await controller.stop(resource.id)
    } catch (error) {
      setOperationError(error instanceof Error
        ? error.message
        : kind === 'remove' ? copy.deleteFailed : copy.transitionFailed)
    } finally {
      setOperation(null)
    }
  }
  const submitRename = async () => {
    if (!resource) return
    const next = name.trim()
    setRenaming(false)
    if (!next || next === resource.name) {
      setName(resource.name)
      return
    }
    setOperationError('')
    try {
      await controller.rename(resource.id, next)
    } catch (error) {
      setName(resource.name)
      setOperationError(error instanceof Error ? error.message : copy.renameFailed)
    }
  }
  const controlDetail = resource?.controlOwner === 'human' ? copy.humanControl : copy.agentControl
  const detail = operationError
    ? operationError
    : resource?.status === 'failed'
      ? resource.error || copy.failed
      : resource?.status === 'starting'
        ? copy.starting
        : resource?.status === 'stopping'
          ? copy.stopping
          : resource?.status === 'running'
            ? [controlDetail, isolatedBrowserCount > 0 ? copy.browserInUse(isolatedBrowserCount) : '']
                .filter(Boolean)
                .join(' · ')
            : copy.stopped
  const busy = operation !== null || resource?.status === 'starting' || resource?.status === 'stopping'
  const stopBlocked = resource?.status === 'running' && isolatedBrowserCount > 0
  if (controller.capability?.enabled !== true) return null
  return (
    <section className="farming-computer-section code-sidebar-resource-section" data-testid="farming-computer-section">
      <header className="code-sidebar-resource-header">
        <button
          type="button"
          className="farming-computer-section-toggle code-sidebar-resource-section-toggle"
          aria-expanded={!collapsed}
          onClick={onToggle}
        >
          <span className="code-sidebar-resource-section-chevron" aria-hidden="true">
            {collapsed ? <ChevronRightGlyph /> : <ChevronDownGlyph />}
          </span>
          <span>{copy.title}</span>
          {resource && <small>1</small>}
        </button>
        {!resource && (
          <button
            type="button"
            className="code-sidebar-resource-header-action"
            title={copy.create}
            aria-label={copy.create}
            onClick={() => void create()}
          >
            <PlusGlyph />
          </button>
        )}
      </header>
      {!collapsed && (
        resource ? (
          <div
            className={`farming-computer-row code-sidebar-resource-row ${active ? 'active' : ''}`}
            data-testid="farming-computer-row"
            role="button"
            tabIndex={0}
            onClick={() => onOpen(resource)}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') onOpen(resource)
            }}
          >
            <span className={`farming-computer-resource-icon code-sidebar-resource-icon ${resource.status}`} aria-hidden="true"><DesktopGlyph /></span>
            <span className="farming-computer-copy code-sidebar-resource-copy">
              {renaming ? (
                <input
                  autoFocus
                  value={name}
                  aria-label={copy.name}
                  onClick={event => event.stopPropagation()}
                  onChange={event => setName(event.currentTarget.value)}
                  onBlur={() => void submitRename()}
                  onKeyDown={event => {
                    event.stopPropagation()
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      void submitRename()
                    } else if (event.key === 'Escape') {
                      setName(resource.name)
                      setRenaming(false)
                    }
                  }}
                />
              ) : <span className="farming-computer-name code-sidebar-resource-name">{resource.name}</span>}
              <span
                className={`farming-computer-detail code-sidebar-resource-detail ${operationError ? 'error' : ''}`}
                title={operationError || resource.error}
              >
                {operation === 'remove' ? copy.removing : operation === 'stop' ? copy.stopping : operation === 'start' ? copy.starting : detail}
              </span>
            </span>
            <span className="farming-computer-actions code-sidebar-resource-actions" data-action-count="2">
              <span title={stopBlocked ? copy.stopBrowsersFirst : undefined}>
                <button
                  type="button"
                  title={stopBlocked ? undefined : resource.status === 'running' ? copy.stop : copy.start}
                  aria-label={resource.status === 'running' ? copy.stop : copy.start}
                  disabled={busy || stopBlocked}
                  onClick={event => {
                    event.stopPropagation()
                    void runOperation(resource.status === 'running' ? 'stop' : 'start')
                  }}
                >
                  {resource.status === 'running' ? <SquareGlyph /> : <PlayGlyph />}
                </button>
              </span>
              <span className="farming-computer-more-wrap">
                <button
                  ref={moreButtonRef}
                  type="button"
                  title={copy.more}
                  aria-label={copy.more}
                  aria-haspopup="menu"
                  aria-expanded={moreOpen}
                  disabled={busy}
                  onClick={event => {
                    event.stopPropagation()
                    setMoreOpen(current => !current)
                  }}
                >
                  <MoreGlyph />
                </button>
                {moreOpen && (
                  <div ref={moreMenuRef} className="farming-computer-more-menu" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={event => {
                        event.stopPropagation()
                        setMoreOpen(false)
                        setName(resource.name)
                        setRenaming(true)
                      }}
                    >
                      {copy.rename}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="danger"
                      onClick={event => {
                        event.stopPropagation()
                        setMoreOpen(false)
                        if (!window.confirm(copy.removeConfirm(resource.name))) return
                        void runOperation('remove')
                      }}
                    >
                      {copy.remove}
                    </button>
                  </div>
                )}
              </span>
            </span>
          </div>
        ) : (
          <button
            type="button"
            className="farming-computer-empty code-sidebar-resource-empty"
            onClick={() => void create()}
          >
            <PlusGlyph />
            <span>{copy.create}</span>
          </button>
        )
      )}
    </section>
  )
}
