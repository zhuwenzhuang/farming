import type { MainPaneMode, WorkspaceView } from './types'

/**
 * Remembered Agent, file and Resource identities are return targets, not proof
 * that their view is visible. All sidebar consumers use this same projection.
 * Loading/failed navigation owns its target page, never the previous row.
 */
export function visibleNavigationPane(
  view: WorkspaceView,
  pane: MainPaneMode,
  agentOpening: boolean,
): MainPaneMode | null {
  return view === 'projects' && !agentOpening ? pane : null
}
