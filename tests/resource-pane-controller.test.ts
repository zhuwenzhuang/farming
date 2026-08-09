import assert from 'node:assert/strict'
import test from 'node:test'
import {
  initialResourcePaneState,
  resourcePaneBackTarget,
  resourcePaneReducer,
} from '../src/components/code/useResourcePaneController'

const collections = (browser: string[], computer: string[], loaded = true) => ({
  browser: { loaded, ids: browser },
  computer: { loaded, ids: computer },
})

test('uses the URL resource surface with computer taking precedence', () => {
  assert.deepEqual(initialResourcePaneState(), {
    mainPaneMode: 'terminal',
    activeBrowserId: null,
    browserReturnAgentId: null,
    activeComputerId: null,
    computerReturnAgentId: null,
  })
  assert.equal(initialResourcePaneState({ browserId: 'browser' }).mainPaneMode, 'browser')
  assert.equal(initialResourcePaneState({ browserId: 'browser', computerId: 'computer' }).mainPaneMode, 'computer')
})

test('resource selection is mutually exclusive at the visible pane and retains its return target', () => {
  const browser = resourcePaneReducer(initialResourcePaneState(), {
    type: 'show-browser', id: 'browser', returnAgentId: 'agent-a',
  })
  const computer = resourcePaneReducer(browser, {
    type: 'show-computer', id: 'computer', returnAgentId: 'agent-b',
  })
  assert.equal(browser.mainPaneMode, 'browser')
  assert.equal(computer.mainPaneMode, 'computer')
  assert.equal(computer.computerReturnAgentId, 'agent-b')
})

test('resource reconciliation waits for loaded collections and only closes a missing active resource', () => {
  const active = resourcePaneReducer(initialResourcePaneState(), {
    type: 'show-browser', id: 'active', returnAgentId: null,
  })
  const pending = resourcePaneReducer(active, {
    type: 'reconcile-resources', collections: collections([], [], false),
  })
  assert.equal(pending.mainPaneMode, 'browser')

  const unrelatedDelete = resourcePaneReducer(active, {
    type: 'reconcile-resources', collections: collections(['active'], []),
  })
  assert.equal(unrelatedDelete.mainPaneMode, 'browser')

  const activeDelete = resourcePaneReducer(active, {
    type: 'reconcile-resources', collections: collections([], []),
  })
  assert.equal(activeDelete.mainPaneMode, 'terminal')
  assert.equal(activeDelete.activeBrowserId, null)
})

test('terminal and editor mode changes preserve the selected resource, and back prefers capture', () => {
  const selected = resourcePaneReducer(initialResourcePaneState(), {
    type: 'show-browser', id: 'browser', returnAgentId: 'captured',
  })
  const editor = resourcePaneReducer(selected, { type: 'show-editor' })
  const terminal = resourcePaneReducer(editor, { type: 'show-terminal' })
  assert.equal(editor.activeBrowserId, 'browser')
  assert.equal(terminal.activeBrowserId, 'browser')
  assert.equal(resourcePaneBackTarget('captured', 'active'), 'captured')
  assert.equal(resourcePaneBackTarget(null, 'active'), 'active')
  assert.equal(resourcePaneBackTarget(null, null), null)
})
