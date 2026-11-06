import assert from 'node:assert/strict'
import test from 'node:test'
import { visibleNavigationPane } from '../src/components/code/navigation-highlight'
import type { MainPaneMode, WorkspaceView } from '../src/components/code/types'

test('sidebar projects only the visible navigation pane, not remembered return identities', () => {
  const panes: MainPaneMode[] = ['terminal', 'editor', 'browser', 'computer']
  const views: WorkspaceView[] = ['projects', 'search', 'history', 'plugins']
  for (const pane of panes) {
    for (const view of views) {
      assert.equal(visibleNavigationPane(view, pane, false), view === 'projects' ? pane : null)
      assert.equal(visibleNavigationPane(view, pane, true), null)
    }
  }
})
