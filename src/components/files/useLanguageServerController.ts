import { useCallback, useEffect, useMemo, useState, type MutableRefObject } from 'react'
import * as monaco from 'monaco-editor'
import { fetchLanguageServerCapability, requestLanguageServerOutcome } from '../../../extensions/language-server/frontend/client'
import { bindLanguageServerModels, refreshLanguageServerDiagnostics, setLanguageServerEditorOpener } from '../../../extensions/language-server/frontend/monaco-providers'
import type {
  LanguageServerCapability,
  LanguageServerHierarchyItem,
  LanguageServerSymbol,
} from '../../../extensions/language-server/frontend/types'
import type { OpenWorkspaceFile, WorkspaceFileOpenTarget } from '@/lib/workspace-open-files'
import type { FileEditorContextAction } from './FileEditorContextMenu'

export type LanguageNavigatorMode = 'call' | 'type' | 'document' | 'workspace'
export type LanguageNavigatorDirection = 'incoming' | 'outgoing' | 'supertypes' | 'subtypes'

export interface LanguageNavigatorNode {
  key: string
  id?: string
  name: string
  detail: string
  kind: number
  path: string
  lineNumber: number
  column: number
  children?: LanguageNavigatorNode[]
  expanded?: boolean
  loading?: boolean
  error?: string
}

export interface LanguageNavigatorState {
  open: boolean
  mode: LanguageNavigatorMode
  direction: LanguageNavigatorDirection
  loading: boolean
  error: string
  query: string
  nodes: LanguageNavigatorNode[]
}

interface UseLanguageServerControllerOptions {
  openFile: OpenWorkspaceFile
  openFiles: OpenWorkspaceFile[]
  editorRef: MutableRefObject<monaco.editor.IStandaloneCodeEditor | null>
  onOpenFilePath: (agentId: string, filePath: string, target?: WorkspaceFileOpenTarget) => Promise<void> | void
  unsupportedMessage: string
}

function positionForEditor(editor: monaco.editor.IStandaloneCodeEditor) {
  const position = editor.getPosition() || { lineNumber: 1, column: 1 }
  return { line: position.lineNumber - 1, character: position.column - 1 }
}

function itemNode(item: LanguageServerHierarchyItem, keyPrefix = ''): LanguageNavigatorNode {
  const range = item.selectionRange || item.range
  return {
    key: `${keyPrefix}${item.id}`,
    id: item.id,
    name: item.name,
    detail: item.detail || '',
    kind: item.kind,
    path: item.path,
    lineNumber: (range?.start.line || 0) + 1,
    column: (range?.start.character || 0) + 1,
  }
}

function symbolNodes(symbols: LanguageServerSymbol[], defaultPath: string, prefix = ''): LanguageNavigatorNode[] {
  return symbols.map((symbol, index) => {
    const range = symbol.selectionRange || symbol.range
    const key = `${prefix}${index}:${symbol.name}:${range?.start.line || 0}`
    return {
      key,
      name: symbol.name,
      detail: symbol.detail || '',
      kind: symbol.kind,
      path: symbol.path || defaultPath,
      lineNumber: (range?.start.line || 0) + 1,
      column: (range?.start.character || 0) + 1,
      children: symbolNodes(symbol.children || [], symbol.path || defaultPath, `${key}/`),
      expanded: true,
    }
  })
}

function updateNode(nodes: LanguageNavigatorNode[], key: string, updater: (node: LanguageNavigatorNode) => LanguageNavigatorNode): LanguageNavigatorNode[] {
  return nodes.map(node => {
    if (node.key === key) return updater(node)
    if (!node.children?.length) return node
    return { ...node, children: updateNode(node.children, key, updater) }
  })
}

const CLOSED_STATE: LanguageNavigatorState = {
  open: false,
  mode: 'call',
  direction: 'incoming',
  loading: false,
  error: '',
  query: '',
  nodes: [],
}

function capabilityIncludesWorkspace(capability: LanguageServerCapability, workspaceRoot: string | undefined) {
  if (!workspaceRoot) return true
  const normalizedRoot = workspaceRoot.replace(/\\/g, '/').replace(/\/$/, '')
  return capability.workspaces.some(value => {
    try {
      const url = new URL(value)
      const pathname = decodeURIComponent(url.pathname).replace(/\\/g, '/').replace(/\/$/, '')
      const normalizedPath = /^\/[A-Za-z]:/.test(pathname) ? pathname.slice(1) : pathname
      return normalizedPath === normalizedRoot
    } catch {
      return false
    }
  })
}

export function useLanguageServerController({
  openFile,
  openFiles,
  editorRef,
  onOpenFilePath,
  unsupportedMessage,
}: UseLanguageServerControllerOptions) {
  const [capability, setCapability] = useState<LanguageServerCapability | null>(null)
  const [navigator, setNavigator] = useState<LanguageNavigatorState>(CLOSED_STATE)

  useEffect(() => {
    bindLanguageServerModels(openFiles)
  }, [openFiles])

  useEffect(() => {
    setLanguageServerEditorOpener((binding, selection) => onOpenFilePath(binding.rootId, binding.filePath, {
      lineNumber: selection && 'startLineNumber' in selection ? selection.startLineNumber : selection?.lineNumber,
      column: selection && 'startColumn' in selection ? selection.startColumn : selection?.column,
      endLineNumber: selection && 'endLineNumber' in selection ? selection.endLineNumber : undefined,
      endColumn: selection && 'endColumn' in selection ? selection.endColumn : undefined,
      transient: true,
      revealInTree: true,
    }))
    return () => setLanguageServerEditorOpener(null)
  }, [onOpenFilePath])

  useEffect(() => {
    let active = true
    void fetchLanguageServerCapability().then(value => {
      if (active) setCapability(value)
    }).catch(() => {
      if (active) setCapability(null)
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (capability?.status !== 'connected') return
    let active = true
    const timeout = window.setTimeout(() => {
      void refreshLanguageServerDiagnostics(openFile).catch(() => {
        if (!active) return
      })
    }, 120)
    return () => {
      active = false
      window.clearTimeout(timeout)
    }
  }, [capability?.status, openFile])

  const available = Boolean(
    capability?.status === 'connected'
    && capabilityIncludesWorkspace(capability, openFile.workspaceRoot)
    && !openFile.dirty
    && !openFile.externalChanged,
  )

  const prepareHierarchy = useCallback(async (mode: 'call' | 'type') => {
    const editor = editorRef.current
    if (!editor || !available) return
    const direction = mode === 'call' ? 'incoming' : 'subtypes'
    setNavigator({ ...CLOSED_STATE, open: true, mode, direction, loading: true })
    try {
      const outcome = await requestLanguageServerOutcome<LanguageServerHierarchyItem[]>({
        rootId: openFile.agentId,
        filePath: openFile.file.path,
        method: mode === 'call' ? 'prepareCallHierarchy' : 'prepareTypeHierarchy',
        position: positionForEditor(editor),
      })
      if (!outcome.supported) throw new Error(unsupportedMessage)
      setNavigator(current => ({
        ...current,
        loading: false,
        nodes: (outcome.result || []).map(item => itemNode(item)),
      }))
    } catch (error) {
      setNavigator(current => ({ ...current, loading: false, error: error instanceof Error ? error.message : String(error) }))
    }
  }, [available, editorRef, openFile.agentId, openFile.file.path, unsupportedMessage])

  const openDocumentSymbols = useCallback(async () => {
    if (!available) return
    setNavigator({ ...CLOSED_STATE, open: true, mode: 'document', direction: 'incoming', loading: true })
    try {
      const outcome = await requestLanguageServerOutcome<LanguageServerSymbol[]>({
        rootId: openFile.agentId,
        filePath: openFile.file.path,
        method: 'documentSymbols',
      })
      if (!outcome.supported) throw new Error(unsupportedMessage)
      setNavigator(current => ({ ...current, loading: false, nodes: symbolNodes(outcome.result || [], openFile.file.path) }))
    } catch (error) {
      setNavigator(current => ({ ...current, loading: false, error: error instanceof Error ? error.message : String(error) }))
    }
  }, [available, openFile.agentId, openFile.file.path, unsupportedMessage])

  const searchWorkspaceSymbols = useCallback(async (query: string) => {
    if (!available) return
    setNavigator(current => ({ ...current, open: true, mode: 'workspace', loading: true, error: '', query }))
    try {
      const outcome = await requestLanguageServerOutcome<LanguageServerSymbol[]>({
        rootId: openFile.agentId,
        method: 'workspaceSymbols',
        query,
      })
      if (!outcome.supported) throw new Error(unsupportedMessage)
      setNavigator(current => ({ ...current, loading: false, nodes: symbolNodes(outcome.result || [], openFile.file.path) }))
    } catch (error) {
      setNavigator(current => ({ ...current, loading: false, error: error instanceof Error ? error.message : String(error) }))
    }
  }, [available, openFile.agentId, openFile.file.path, unsupportedMessage])

  const openWorkspaceSymbols = useCallback(() => {
    const selection = editorRef.current?.getSelection()
    const model = editorRef.current?.getModel()
    const selected = selection && model ? model.getValueInRange(selection).trim() : ''
    const word = editorRef.current?.getModel()?.getWordAtPosition(editorRef.current.getPosition() || { lineNumber: 1, column: 1 })?.word || ''
    void searchWorkspaceSymbols(selected || word)
  }, [editorRef, searchWorkspaceSymbols])

  const runAction = useCallback(async (action: FileEditorContextAction) => {
    const editor = editorRef.current
    if (!editor || !available) return
    if (action === 'go-to-definition') await editor.getAction('editor.action.revealDefinition')?.run()
    else if (action === 'find-references') await editor.getAction('editor.action.referenceSearch.trigger')?.run()
    else if (action === 'go-to-implementation') await editor.getAction('editor.action.goToImplementation')?.run()
    else if (action === 'call-hierarchy') await prepareHierarchy('call')
    else if (action === 'type-hierarchy') await prepareHierarchy('type')
    else if (action === 'document-symbols') await openDocumentSymbols()
    else if (action === 'workspace-symbols') openWorkspaceSymbols()
  }, [available, editorRef, openDocumentSymbols, openWorkspaceSymbols, prepareHierarchy])

  const changeDirection = useCallback((direction: LanguageNavigatorDirection) => {
    setNavigator(current => ({
      ...current,
      direction,
      nodes: current.nodes.map(node => ({ ...node, children: undefined, expanded: false, error: undefined })),
    }))
  }, [])

  const toggleNode = useCallback(async (node: LanguageNavigatorNode) => {
    if (!node.id || (navigator.mode !== 'call' && navigator.mode !== 'type')) return
    if (node.children) {
      setNavigator(current => ({ ...current, nodes: updateNode(current.nodes, node.key, value => ({ ...value, expanded: !value.expanded })) }))
      return
    }
    setNavigator(current => ({ ...current, nodes: updateNode(current.nodes, node.key, value => ({ ...value, expanded: true, loading: true })) }))
    try {
      const method = navigator.mode === 'call'
        ? navigator.direction === 'outgoing' ? 'outgoingCalls' : 'incomingCalls'
        : navigator.direction === 'supertypes' ? 'supertypes' : 'subtypes'
      const outcome = await requestLanguageServerOutcome<Array<LanguageServerHierarchyItem | { item: LanguageServerHierarchyItem }>>({
        rootId: openFile.agentId,
        method,
        itemId: node.id,
      })
      if (!outcome.supported) throw new Error(unsupportedMessage)
      const children = (outcome.result || []).map(value => itemNode('item' in value ? value.item : value, `${node.key}/`))
      setNavigator(current => ({
        ...current,
        nodes: updateNode(current.nodes, node.key, value => ({ ...value, loading: false, expanded: true, children })),
      }))
    } catch (error) {
      setNavigator(current => ({
        ...current,
        nodes: updateNode(current.nodes, node.key, value => ({ ...value, loading: false, error: error instanceof Error ? error.message : String(error) })),
      }))
    }
  }, [navigator.direction, navigator.mode, openFile.agentId, unsupportedMessage])

  const openNode = useCallback((node: LanguageNavigatorNode) => {
    void onOpenFilePath(openFile.agentId, node.path, {
      lineNumber: node.lineNumber,
      column: node.column,
      transient: true,
      revealInTree: true,
    })
  }, [onOpenFilePath, openFile.agentId])

  return useMemo(() => ({
    available,
    capability,
    navigator,
    runAction,
    closeNavigator: () => setNavigator(CLOSED_STATE),
    changeDirection,
    toggleNode,
    openNode,
    searchWorkspaceSymbols,
  }), [available, capability, changeDirection, navigator, openNode, runAction, searchWorkspaceSymbols, toggleNode])
}
