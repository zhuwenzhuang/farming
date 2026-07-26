import { createPortal } from 'react-dom'
import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import type { ProjectGroup } from '@/components/code/types'
import type { BrowserResource } from './types'
import type { BrowserResourcesController } from './useBrowserResources'

const COLLAPSED_KEY = 'farming.code.browserSectionsCollapsed.v1'

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

function resourceStatusLabel(resource: BrowserResource) {
  if (resource.status === 'running') return resource.url.replace(/^https?:\/\//, '') || 'about:blank'
  if (resource.status === 'failed') return resource.error || 'Browser failed'
  if (resource.status === 'starting') return 'Starting…'
  if (resource.status === 'stopping') return 'Stopping…'
  return 'Stopped'
}

function BrowserRow({
  resource,
  active,
  controller,
  onOpen,
}: {
  resource: BrowserResource
  active: boolean
  controller: BrowserResourcesController
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
      window.alert(error instanceof Error ? error.message : 'Failed to rename Browser')
    })
  }
  return (
    <div
      className={`farming-browser-row ${active ? 'active' : ''}`}
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
      <span className={`farming-browser-status ${resource.status}`} aria-hidden="true" />
      <span className="farming-browser-row-copy">
        {renaming ? (
          <input
            autoFocus
            value={name}
            aria-label="Browser name"
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
          <strong>{resource.name}</strong>
        )}
        <span title={resource.error || resource.url}>{resourceStatusLabel(resource)}</span>
      </span>
      <span className="farming-browser-row-actions">
        <button
          type="button"
          title="Rename Browser"
          aria-label="Rename Browser"
          onClick={event => {
            event.stopPropagation()
            setRenaming(true)
          }}
        >
          ✎
        </button>
        <button
          type="button"
          disabled={busy}
          title={resource.status === 'running' ? 'Stop Browser' : 'Start Browser'}
          aria-label={resource.status === 'running' ? 'Stop Browser' : 'Start Browser'}
          onClick={event => {
            event.stopPropagation()
            const operation = resource.status === 'running' ? controller.stop(resource.id) : controller.start(resource.id)
            void operation.catch(error => window.alert(error instanceof Error ? error.message : 'Browser transition failed'))
          }}
        >
          {resource.status === 'running' ? '■' : '▶'}
        </button>
        <button
          type="button"
          title="Delete Browser"
          aria-label="Delete Browser"
          onClick={event => {
            event.stopPropagation()
            if (!window.confirm(`Delete Browser “${resource.name}” and its isolated profile?`)) return
            void controller.remove(resource.id).catch(error => {
              window.alert(error instanceof Error ? error.message : 'Failed to delete Browser')
            })
          }}
        >
          ×
        </button>
      </span>
    </div>
  )
}

function BrowserSection({
  project,
  resources,
  activeBrowserId,
  controller,
  collapsed,
  onToggle,
  onOpen,
}: {
  project: ProjectGroup
  resources: BrowserResource[]
  activeBrowserId: string | null
  controller: BrowserResourcesController
  collapsed: boolean
  onToggle: () => void
  onOpen: (resource: BrowserResource) => void
}) {
  const createBrowser = async () => {
    try {
      const resource = await controller.create(project.workspace)
      const running = await controller.start(resource.id)
      onOpen(running)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Failed to create Browser')
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
          <span aria-hidden="true">{collapsed ? '›' : '⌄'}</span>
          <strong>Browsers</strong>
          <small>{resources.length}</small>
        </button>
        <button
          type="button"
          className="farming-browser-new"
          title="New Browser"
          aria-label="New Browser"
          disabled={controller.capability?.available === false}
          onClick={() => void createBrowser()}
        >
          +
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
              onOpen={onOpen}
            />
          ))}
          {resources.length === 0 && (
            <button
              type="button"
              className="farming-browser-empty"
              disabled={controller.capability?.available === false}
              title={controller.capability?.message}
              onClick={() => void createBrowser()}
            >
              {controller.capability?.available === false ? controller.capability.message : 'Open a real browser'}
            </button>
          )}
        </div>
      )}
    </section>
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

export function BrowserSidebarPortals({
  projects,
  collapsedProjectIds,
  activeBrowserId,
  controller,
  onOpen,
}: {
  projects: ProjectGroup[]
  collapsedProjectIds: ReadonlySet<string>
  activeBrowserId: string | null
  controller: BrowserResourcesController
  onOpen: (resource: BrowserResource) => void
}) {
  const [targets, setTargets] = useState(new Map<string, HTMLElement>())
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const refreshTargets = useCallback(() => {
    const next = new Map<string, HTMLElement>()
    for (const project of projects) {
      if (collapsedProjectIds.has(project.id)) continue
      const target = findProjectExpandedElement(project.id)
      if (target) next.set(project.id, target)
    }
    setTargets(current => {
      if (current.size === next.size && [...next].every(([id, element]) => current.get(id) === element)) return current
      return next
    })
  }, [collapsedProjectIds, projects])

  useLayoutEffect(refreshTargets, [refreshTargets])
  useEffect(() => {
    const observer = new MutationObserver(refreshTargets)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [refreshTargets])

  const toggle = (projectId: string) => {
    setCollapsed(current => {
      const next = new Set(current)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      writeCollapsed(next)
      return next
    })
  }

  return (
    <>
      {projects.map(project => {
        const target = targets.get(project.id)
        if (!target || !project.workspace) return null
        return createPortal(
          <BrowserSection
            project={project}
            resources={controller.byWorkspace.get(project.workspace) ?? []}
            activeBrowserId={activeBrowserId}
            controller={controller}
            collapsed={collapsed.has(project.id)}
            onToggle={() => toggle(project.id)}
            onOpen={onOpen}
          />,
          target,
          `browser-section:${project.id}`,
        )
      })}
    </>
  )
}
