import { useCallback, useReducer } from 'react'
import type { MainPaneMode } from './types'

export type ResourcePaneState = {
  mainPaneMode: MainPaneMode
  activeBrowserId: string | null
  browserReturnAgentId: string | null
  activeComputerId: string | null
  computerReturnAgentId: string | null
}

export type ResourceCollectionSnapshot = {
  loaded: boolean
  ids: Iterable<string>
}

export type ResourcePaneCollections = {
  browser: ResourceCollectionSnapshot
  computer: ResourceCollectionSnapshot
}

export type ResourcePaneAction =
  | { type: 'show-browser'; id: string; returnAgentId: string | null }
  | { type: 'show-computer'; id: string; returnAgentId: string | null }
  | { type: 'show-terminal' }
  | { type: 'show-editor' }
  | { type: 'set-main-pane-mode'; mode: MainPaneMode }
  | { type: 'reconcile-resources'; collections: ResourcePaneCollections }

export function initialResourcePaneState(initial: {
  browserId?: string | null
  computerId?: string | null
} = {}): ResourcePaneState {
  const browserId = initial.browserId ?? null
  const computerId = initial.computerId ?? null
  return {
    activeBrowserId: browserId,
    browserReturnAgentId: null,
    activeComputerId: computerId,
    computerReturnAgentId: null,
    mainPaneMode: computerId ? 'computer' : browserId ? 'browser' : 'terminal',
  }
}

function hasId(collection: ResourceCollectionSnapshot, id: string | null) {
  if (!id || !collection.loaded) return true
  for (const candidate of collection.ids) {
    if (candidate === id) return true
  }
  return false
}

export function resourcePaneReducer(
  state: ResourcePaneState,
  action: ResourcePaneAction,
): ResourcePaneState {
  switch (action.type) {
    case 'show-browser':
      return {
        ...state,
        mainPaneMode: 'browser',
        activeBrowserId: action.id,
        browserReturnAgentId: action.returnAgentId,
      }
    case 'show-computer':
      return {
        ...state,
        mainPaneMode: 'computer',
        activeComputerId: action.id,
        computerReturnAgentId: action.returnAgentId,
      }
    case 'show-terminal':
      return state.mainPaneMode === 'terminal' ? state : { ...state, mainPaneMode: 'terminal' }
    case 'show-editor':
      return state.mainPaneMode === 'editor' ? state : { ...state, mainPaneMode: 'editor' }
    case 'set-main-pane-mode':
      return state.mainPaneMode === action.mode ? state : { ...state, mainPaneMode: action.mode }
    case 'reconcile-resources': {
      const browserMissing = !hasId(action.collections.browser, state.activeBrowserId)
      const computerMissing = !hasId(action.collections.computer, state.activeComputerId)
      if (!browserMissing && !computerMissing) return state

      const next = {
        ...state,
        activeBrowserId: browserMissing ? null : state.activeBrowserId,
        activeComputerId: computerMissing ? null : state.activeComputerId,
      }
      if (
        (state.mainPaneMode === 'browser' && browserMissing)
        || (state.mainPaneMode === 'computer' && computerMissing)
      ) {
        next.mainPaneMode = 'terminal'
      }
      return next
    }
  }
}

export function resourcePaneBackTarget(
  capturedReturnAgentId: string | null,
  activeAgentId: string | null,
) {
  return capturedReturnAgentId || activeAgentId || null
}

export function useResourcePaneController(initial: {
  browserId?: string | null
  computerId?: string | null
}) {
  const [state, dispatch] = useReducer(resourcePaneReducer, initial, initialResourcePaneState)
  const showBrowser = useCallback((id: string, returnAgentId: string | null) => {
    dispatch({ type: 'show-browser', id, returnAgentId })
  }, [])
  const showComputer = useCallback((id: string, returnAgentId: string | null) => {
    dispatch({ type: 'show-computer', id, returnAgentId })
  }, [])
  const showTerminal = useCallback(() => dispatch({ type: 'show-terminal' }), [])
  const showEditor = useCallback(() => dispatch({ type: 'show-editor' }), [])
  const setMainPaneMode = useCallback((mode: MainPaneMode) => {
    dispatch({ type: 'set-main-pane-mode', mode })
  }, [])
  const reconcileResources = useCallback((collections: ResourcePaneCollections) => {
    dispatch({ type: 'reconcile-resources', collections })
  }, [])

  return {
    ...state,
    showBrowser,
    showComputer,
    showTerminal,
    showEditor,
    setMainPaneMode,
    reconcileResources,
  }
}
