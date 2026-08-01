import {
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import { ArrowLeftGlyph, ArrowRightGlyph, BackToAgentGlyph } from '@/components/IconGlyphs'
import { iconForFilePath } from '@/lib/file-icons'
import {
  workspaceEditorBasename as basename,
  workspaceEditorModelKey as openFileKey,
  workspaceEditorTabDomId as fileEditorTabDomId,
  workspaceEditorTabLabel as fileEditorTabLabel,
} from '@/lib/workspace-editor-model'
import type { OpenWorkspaceFile, WorkspaceFileOpenTarget } from '@/lib/workspace-open-files'
import {
  workspaceWorkingCopyChangeIndicator,
  workspaceWorkingCopyTabClass,
} from '@/lib/workspace-working-copy'
import type { CodeCopy } from '../code/copy'

export interface FileEditorTabsProps {
  openFile: OpenWorkspaceFile
  openFiles: OpenWorkspaceFile[]
  copy: CodeCopy
  onBackToAgent: (agentId: string) => void
  onSelectOpenFile: (agentId: string, filePath: string, target?: WorkspaceFileOpenTarget) => boolean
  canNavigateBack: boolean
  canNavigateForward: boolean
  onNavigateHistory: (direction: -1 | 1) => boolean
  onSetTabRef: (key: string, element: HTMLDivElement | null) => void
  onOpenTabContextMenu: (event: ReactMouseEvent<HTMLDivElement>, index: number) => void
  onTabAuxClick: (event: ReactMouseEvent<HTMLDivElement>, index: number) => void
  onTabKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>, index: number) => void
  onCloseTab: (index: number) => void
  onReorderOpenFile: (sourceKey: string, targetKey: string, position: 'before' | 'after') => void
  actions: ReactNode
}

interface FileEditorTabDragState {
  sourceKey: string
  targetKey: string
  position: 'before' | 'after'
}

function tabDropPosition(event: ReactDragEvent<HTMLDivElement>) {
  const rect = event.currentTarget.getBoundingClientRect()
  return event.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
}

export function FileEditorTabs({
  openFile,
  openFiles,
  copy,
  onBackToAgent,
  onSelectOpenFile,
  canNavigateBack,
  canNavigateForward,
  onNavigateHistory,
  onSetTabRef,
  onOpenTabContextMenu,
  onTabAuxClick,
  onTabKeyDown,
  onCloseTab,
  onReorderOpenFile,
  actions,
}: FileEditorTabsProps) {
  const [tabDrag, setTabDrag] = useState<FileEditorTabDragState | null>(null)
  const tabStripRef = useRef<HTMLDivElement | null>(null)
  const draggedTabKeyRef = useRef<string | null>(null)

  useLayoutEffect(() => {
    const tabStrip = tabStripRef.current
    const actionBar = tabStrip?.querySelector<HTMLElement>(':scope > .code-file-editor-actions')
    if (!tabStrip || !actionBar) return
    const syncActionWidth = () => {
      tabStrip.style.setProperty('--code-file-editor-actions-width', `${Math.ceil(actionBar.getBoundingClientRect().width)}px`)
    }
    syncActionWidth()
    const observer = new ResizeObserver(syncActionWidth)
    observer.observe(actionBar)
    return () => observer.disconnect()
  }, [])

  const finishTabDrag = () => {
    setTabDrag(null)
    window.setTimeout(() => {
      draggedTabKeyRef.current = null
    }, 0)
  }

  return (
    <div ref={tabStripRef} className="code-file-editor-tab-strip">
      <div className="code-file-editor-navigation">
        {openFile.sourceAgentId && (
          <>
            <button
              type="button"
              className="code-file-editor-action code-file-editor-agent-return"
              onClick={() => onBackToAgent(openFile.sourceAgentId!)}
              aria-label={copy.backToAgent}
              title={copy.backToAgent}
              data-testid="code-file-editor-back"
            >
              <BackToAgentGlyph className="code-file-editor-action-svg" />
            </button>
            <span className="code-file-editor-navigation-divider" aria-hidden="true" />
          </>
        )}
        <button
          type="button"
          className="code-file-editor-action code-file-editor-history-back"
          onClick={() => {
            void onNavigateHistory(-1)
          }}
          disabled={!canNavigateBack}
          aria-label={copy.goBack}
          title={copy.goBack}
          data-testid="code-file-editor-history-back"
        >
          <ArrowLeftGlyph className="code-file-editor-action-svg" />
        </button>
        <button
          type="button"
          className="code-file-editor-action code-file-editor-history-forward"
          onClick={() => {
            void onNavigateHistory(1)
          }}
          disabled={!canNavigateForward}
          aria-label={copy.goForward}
          title={copy.goForward}
          data-testid="code-file-editor-history-forward"
        >
          <ArrowRightGlyph className="code-file-editor-action-svg" />
        </button>
      </div>
      <div className="code-file-editor-tabs" role="tablist">
        {openFiles.map((file, index) => {
          const tabKey = openFileKey(file)
          const active = tabKey === openFileKey(openFile)
          const tabStateClass = workspaceWorkingCopyTabClass(file)
          const changeIndicator = workspaceWorkingCopyChangeIndicator(file)
          return (
            <div
              id={fileEditorTabDomId(file)}
              key={tabKey}
              ref={element => onSetTabRef(tabKey, element)}
              className={`code-file-editor-tab ${active ? 'active' : ''} ${file.transient ? 'preview' : ''} ${tabStateClass}`.trim()}
              draggable
              data-preview={file.transient ? 'true' : undefined}
              data-dragging={tabDrag?.sourceKey === tabKey ? 'true' : undefined}
              data-drop-position={tabDrag?.targetKey === tabKey ? tabDrag.position : undefined}
              title={file.file.path}
              role="tab"
              aria-selected={active}
              aria-controls="code-file-editor-panel"
              aria-label={fileEditorTabLabel(file)}
              tabIndex={active ? 0 : -1}
              onDragStart={event => {
                if (event.target instanceof Element && event.target.closest('button')) {
                  event.preventDefault()
                  return
                }
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('text/plain', tabKey)
                draggedTabKeyRef.current = tabKey
                setTabDrag({ sourceKey: tabKey, targetKey: '', position: 'before' })
              }}
              onDragOver={event => {
                if (!tabDrag || tabDrag.sourceKey === tabKey) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                const position = tabDropPosition(event)
                if (tabDrag.targetKey === tabKey && tabDrag.position === position) return
                setTabDrag(current => current ? { ...current, targetKey: tabKey, position } : null)
              }}
              onDrop={event => {
                event.preventDefault()
                event.stopPropagation()
                if (tabDrag && tabDrag.sourceKey !== tabKey) {
                  onReorderOpenFile(tabDrag.sourceKey, tabKey, tabDropPosition(event))
                }
                finishTabDrag()
              }}
              onDragEnd={finishTabDrag}
              onClick={event => {
                if (draggedTabKeyRef.current === tabKey) {
                  event.preventDefault()
                  event.stopPropagation()
                  return
                }
                onSelectOpenFile(file.agentId, file.file.path)
              }}
              onDoubleClick={() => onSelectOpenFile(file.agentId, file.file.path, { transient: false })}
              onContextMenu={event => onOpenTabContextMenu(event, index)}
              onAuxClick={event => onTabAuxClick(event, index)}
              onKeyDown={event => onTabKeyDown(event, index)}
            >
              <img className="code-file-type-icon file" src={iconForFilePath(file.file.path)} alt="" aria-hidden="true" />
              <span className="code-file-editor-tab-name">{basename(file.file.path)}</span>
              <span className="code-file-editor-tab-tail">
                {changeIndicator && (
                  <span className="code-file-editor-dirty" title={changeIndicator === 'external' ? copy.changedOnDisk : copy.unsavedChanges} />
                )}
                <button
                  type="button"
                  tabIndex={-1}
                  className="code-file-editor-close"
                  onClick={event => {
                    event.stopPropagation()
                    onCloseTab(index)
                  }}
                  aria-label={copy.closeFile(file.file.path)}
                />
              </span>
            </div>
          )
        })}
      </div>
      {actions}
    </div>
  )
}
