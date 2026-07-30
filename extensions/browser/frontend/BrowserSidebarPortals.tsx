import { createPortal } from 'react-dom'
import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  ChevronDownGlyph,
  ChevronRightGlyph,
  CloseGlyph,
  PencilGlyph,
  PlusGlyph,
  SquareGlyph,
  VisibilityGlyph,
  VisibilityOffGlyph,
} from '@/components/IconGlyphs'
import type { ProjectGroup } from '@/components/code/types'
import type { UiPreferences } from '@/lib/ui-preferences'
import type { BrowserResource } from './types'
import type { BrowserResourcesController } from './useBrowserResources'

const COLLAPSED_KEY = 'farming.code.browserSectionsCollapsed.v1'
const EXPANDED_RESOURCES_KEY = 'farming.code.agentResourcesExpanded.v1'

function readCollapsed() {
  try {
    const parsed = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter(value => typeof value === 'string') : [])
  } catch {
    return new Set<string>()
  }
}

function writeCollapsed(values: Set<string>) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...values]))
  } catch {
    // In-memory collapse state still works.
  }
}

function readExpandedResources() {
  try {
    const parsed = JSON.parse(localStorage.getItem(EXPANDED_RESOURCES_KEY) || '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter(value => typeof value === 'string') : [])
  } catch {
    return new Set<string>()
  }
}

function writeExpandedResources(values: Set<string>) {
  try {
    localStorage.setItem(EXPANDED_RESOURCES_KEY, JSON.stringify([...values]))
  } catch {
    // In-memory expansion state still works.
  }
}

function browserCopy(language: UiPreferences['language']) {
  const zh = language === 'zh'
  return {
    browsers: zh ? '浏览器' : 'Browsers',
    newBrowser: zh ? '新建标签页' : 'New Tab',
    createBrowser: zh ? '新建标签页' : 'Create tab',
    browserName: zh ? '标签页名称' : 'Tab name',
    renameBrowser: zh ? '重命名标签页' : 'Rename Tab',
    startBrowser: zh ? '启动标签页' : 'Start Tab',
    stopBrowser: zh ? '停止标签页' : 'Stop Tab',
    deleteBrowser: zh ? '关闭标签页' : 'Close Tab',
    failed: zh ? '标签页失败' : 'Tab failed',
    starting: zh ? '启动中…' : 'Starting…',
    stopping: zh ? '停止中…' : 'Stopping…',
    stopped: zh ? '已停止' : 'Stopped',
    renameFailed: zh ? '标签页重命名失败' : 'Failed to rename tab',
    transitionFailed: zh ? '标签页状态切换失败' : 'Tab transition failed',
    deleteFailed: zh ? '标签页关闭失败' : 'Failed to close tab',
    createFailed: zh ? '标签页创建失败' : 'Failed to create tab',
    showResources: zh ? '显示 Agent 资源' : 'Show Agent resources',
    hideResources: zh ? '隐藏 Agent 资源' : 'Hide Agent resources',
  }
}

type BrowserCopy = ReturnType<typeof browserCopy>

function BrowserPlayGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M4.5 2.6a.75.75 0 0 1 1.15-.63l7 4.9a.75.75 0 0 1 0 1.23l-7 4.9A.75.75 0 0 1 4.5 12.4V2.6Z" />
    </svg>
  )
}

function resourceStatusLabel(resource: BrowserResource, copy: BrowserCopy) {
  if (resource.status === 'running') return resource.url.replace(/^https?:\/\//, '') || 'about:blank'
  // Failures stay actionable in the Browser view; in the Agent sidebar they
  // are only a noisy transport detail, so present them as a neutral stopped tab.
  if (resource.status === 'failed') return copy.stopped
  if (resource.status === 'starting') return copy.starting
  if (resource.status === 'stopping') return copy.stopping
  return copy.stopped
}

function BrowserRow({
  resource,
  active,
  controller,
  copy,
  onOpen,
}: {
  resource: BrowserResource
  active: boolean
  controller: BrowserResourcesController
  copy: BrowserCopy
  onOpen: (resource: BrowserResource) => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(resource.name)
  const busy = resource.status === 'starting' || resource.status === 'stopping'
  const submitRename = async () => {
    const next = name.trim()
    setRenaming(false)
    if (!next || next === resource.name) {
      setName(resource.name)
      return
    }
    await controller.rename(resource.id, next).catch(error => {
      setName(resource.name)
      window.alert(error instanceof Error ? error.message : copy.renameFailed)
    })
  }
  return (
    <div
      className={`farming-browser-row ${active ? 'active' : ''} ${resource.status === 'running' ? 'running' : ''}`}
      data-testid="farming-browser-row"
      data-browser-id={resource.id}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(resource)}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen(resource)
        }
      }}
    >
      <span className="farming-browser-row-copy">
        {renaming ? (
          <input
            autoFocus
            value={name}
            aria-label={copy.browserName}
            onClick={event => event.stopPropagation()}
            onChange={event => setName(event.currentTarget.value)}
            onBlur={() => void submitRename()}
            onKeyDown={event => {
              event.stopPropagation()
              if (event.key === 'Enter') void submitRename()
              if (event.key === 'Escape') {
                setName(resource.name)
                setRenaming(false)
              }
            }}
          />
        ) : (
          <span className="farming-browser-row-name">{resource.name}</span>
        )}
        <span className="farming-browser-row-detail" title={resource.status === 'running' ? resource.url : undefined}>
          {resourceStatusLabel(resource, copy)}
        </span>
      </span>
      {resource.status === 'running' ? <span className="farming-browser-status" aria-hidden="true" /> : null}
      <span className="farming-browser-row-actions">
        <button
          type="button"
          title={copy.renameBrowser}
          aria-label={copy.renameBrowser}
          onClick={event => {
            event.stopPropagation()
            setRenaming(true)
          }}
        >
          <PencilGlyph />
        </button>
        <button
          type="button"
          disabled={busy}
          title={resource.status === 'running' ? copy.stopBrowser : copy.startBrowser}
          aria-label={resource.status === 'running' ? copy.stopBrowser : copy.startBrowser}
          onClick={event => {
            event.stopPropagation()
            const operation = resource.status === 'running' ? controller.stop(resource.id) : controller.start(resource.id)
            void operation.catch(error => window.alert(error instanceof Error ? error.message : copy.transitionFailed))
          }}
        >
          {resource.status === 'running' ? <SquareGlyph /> : <BrowserPlayGlyph />}
        </button>
        <button
          type="button"
          title={copy.deleteBrowser}
          aria-label={copy.deleteBrowser}
          onClick={event => {
            event.stopPropagation()
            void controller.remove(resource.id).catch(error => {
              window.alert(error instanceof Error ? error.message : copy.deleteFailed)
            })
          }}
        >
          <CloseGlyph />
        </button>
      </span>
    </div>
  )
}

function BrowserSection({
  workspace,
  ownerAgentId,
  resources,
  activeBrowserId,
  controller,
  copy,
  collapsed,
  onToggle,
  onOpen,
}: {
  workspace: string
  ownerAgentId?: string
  resources: BrowserResource[]
  activeBrowserId: string | null
  controller: BrowserResourcesController
  copy: BrowserCopy
  collapsed: boolean
  onToggle: () => void
  onOpen: (resource: BrowserResource) => void
}) {
  const createBrowser = async () => {
    try {
      const resource = await controller.create(workspace, { agentId: ownerAgentId })
      const running = await controller.start(resource.id)
      onOpen(running)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : copy.createFailed)
    }
  }
  return (
    <section className="farming-browser-section" data-testid="farming-browser-section">
      <header>
        <button
          type="button"
          className="farming-browser-section-toggle"
          aria-expanded={!collapsed}
          onClick={onToggle}
        >
          <span className="farming-browser-section-chevron" aria-hidden="true">
            {collapsed ? <ChevronRightGlyph /> : <ChevronDownGlyph />}
          </span>
          <span>{copy.browsers}</span>
          {resources.length > 0 && <small>{resources.length}</small>}
        </button>
        <button
          type="button"
          className="farming-browser-new"
          title={copy.newBrowser}
          aria-label={copy.newBrowser}
          onClick={() => void createBrowser()}
        >
          <PlusGlyph />
        </button>
      </header>
      {!collapsed && (
        <div className="farming-browser-list">
          {resources.map(resource => (
            <BrowserRow
              key={resource.id}
              resource={resource}
              active={resource.id === activeBrowserId}
              controller={controller}
              copy={copy}
              onOpen={onOpen}
            />
          ))}
          {resources.length === 0 && (
            <button
              type="button"
              className="farming-browser-empty"
              onClick={() => void createBrowser()}
            >
              <PlusGlyph />
              <span>{copy.createBrowser}</span>
            </button>
          )}
        </div>
      )}
    </section>
  )
}

function AgentResourceToggle({
  expanded,
  copy,
  onToggle,
}: {
  expanded: boolean
  copy: BrowserCopy
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      className="code-agent-row-action farming-agent-resources-toggle"
      data-testid="code-agent-resources-toggle"
      aria-expanded={expanded}
      aria-label={expanded ? copy.hideResources : copy.showResources}
      title={expanded ? copy.hideResources : copy.showResources}
      onClick={event => {
        event.preventDefault()
        event.stopPropagation()
        onToggle()
      }}
    >
      {expanded ? <VisibilityOffGlyph /> : <VisibilityGlyph />}
    </button>
  )
}

function findProjectExpandedElement(projectId: string) {
  const titles = document.querySelectorAll<HTMLElement>('[data-testid="code-project-title"]')
  for (const title of titles) {
    if (title.dataset.projectId !== projectId) continue
    return title.closest<HTMLElement>('[data-testid="code-project-group"]')
      ?.querySelector<HTMLElement>('.code-project-expanded') ?? null
  }
  return null
}

function findAgentElement(agentId: string, testId: string) {
  return document.querySelector<HTMLElement>(
    `[data-testid="${testId}"][data-agent-id="${CSS.escape(agentId)}"]`,
  )
}

export function BrowserSidebarPortals({
  projects,
  collapsedProjectIds,
  activeBrowserId,
  controller,
  language,
  onOpen,
  additionalAgentResourceIds = new Set<string>(),
  renderAdditionalAgentResources,
  forceAvailable = false,
}: {
  projects: ProjectGroup[]
  collapsedProjectIds: ReadonlySet<string>
  activeBrowserId: string | null
  controller: BrowserResourcesController
  language: UiPreferences['language']
  onOpen: (resource: BrowserResource) => void
  additionalAgentResourceIds?: ReadonlySet<string>
  renderAdditionalAgentResources?: (input: {
    agentId: string
    workspace: string
    expanded: boolean
  }) => ReactNode
  forceAvailable?: boolean
}) {
  const copy = browserCopy(language)
  const browserAvailable = controller.loading === false && controller.capability?.available === true
  const available = forceAvailable || browserAvailable
  const [targets, setTargets] = useState(new Map<string, HTMLElement>())
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [expandedResources, setExpandedResources] = useState(readExpandedResources)
  const refreshTargets = useCallback(() => {
    const next = new Map<string, HTMLElement>()
    for (const project of projects) {
      if (collapsedProjectIds.has(project.id)) continue
      const target = findProjectExpandedElement(project.id)
      if (target) next.set(project.id, target)
      for (const agent of project.agents) {
        const action = findAgentElement(agent.id, 'code-agent-resource-action-slot')
        const content = findAgentElement(agent.id, 'code-agent-resource-slot')
        if (action) next.set(`agent-action:${agent.id}`, action)
        if (content) next.set(`agent-content:${agent.id}`, content)
      }
    }
    setTargets(current => {
      if (current.size === next.size && [...next].every(([id, element]) => current.get(id) === element)) return current
      return next
    })
  }, [collapsedProjectIds, projects])

  useLayoutEffect(() => {
    if (available) {
      refreshTargets()
      return
    }
    setTargets(current => current.size === 0 ? current : new Map())
  }, [available, refreshTargets])
  useEffect(() => {
    if (!available) return undefined
    const observer = new MutationObserver(refreshTargets)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [available, refreshTargets])

  const toggle = (projectId: string) => {
    setCollapsed(current => {
      const next = new Set(current)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      writeCollapsed(next)
      return next
    })
  }

  const toggleAgentResources = (agentId: string) => {
    setExpandedResources(current => {
      const next = new Set(current)
      if (next.has(agentId)) next.delete(agentId)
      else next.add(agentId)
      writeExpandedResources(next)
      return next
    })
  }

  if (!available) return null

  return (
    <>
      {projects.map(project => {
        if (!browserAvailable) return null
        const target = targets.get(project.id)
        if (!target || !project.workspace) return null
        const resources = (controller.byWorkspace.get(project.workspace) ?? [])
          .filter(resource => resource.ownerType === 'project')
        if (resources.length === 0) return null
        return createPortal(
          <BrowserSection
            workspace={project.workspace}
            resources={resources}
            activeBrowserId={activeBrowserId}
            controller={controller}
            copy={copy}
            collapsed={collapsed.has(project.id)}
            onToggle={() => toggle(project.id)}
            onOpen={onOpen}
          />,
          target,
          `browser-section:${project.id}`,
        )
      })}
      {projects.flatMap(project => project.agents.flatMap(agent => {
        const resources = controller.byAgentId.get(agent.id) ?? []
        const hasAdditionalResources = additionalAgentResourceIds.has(agent.id)
        if (resources.length === 0 && !hasAdditionalResources) return []
        const actionTarget = targets.get(`agent-action:${agent.id}`)
        const contentTarget = targets.get(`agent-content:${agent.id}`)
        const expanded = expandedResources.has(agent.id)
        const portals = []
        if (actionTarget) {
          portals.push(createPortal(
            <AgentResourceToggle
              expanded={expanded}
              copy={copy}
              onToggle={() => toggleAgentResources(agent.id)}
            />,
            actionTarget,
            `browser-agent-toggle:${agent.id}`,
          ))
        }
        if (contentTarget && expanded) {
          portals.push(createPortal(
            <>
              {resources.length > 0 && (
                <BrowserSection
                  workspace={project.workspace}
                  ownerAgentId={agent.id}
                  resources={resources}
                  activeBrowserId={activeBrowserId}
                  controller={controller}
                  copy={copy}
                  collapsed={collapsed.has(`agent:${agent.id}`)}
                  onToggle={() => toggle(`agent:${agent.id}`)}
                  onOpen={onOpen}
                />
              )}
              {renderAdditionalAgentResources?.({
                agentId: agent.id,
                workspace: project.workspace,
                expanded,
              })}
            </>,
            contentTarget,
            `browser-agent-section:${agent.id}`,
          ))
        }
        return portals
      }))}
    </>
  )
}
