import assert from 'node:assert/strict'
import { browserTabTitle, browserTabUnreadCount } from '../../src/components/code/browser-tab-status'

const projects = [{
  agents: [
    { unread: true }, { unread: true }, { unread: false },
    { unread: true, isMain: true }, { unread: true, archived: true },
  ],
  agentSessions: [{ unread: true }, { unread: true, archived: true }],
  agentSummary: { unreadCount: 7 },
}]
assert.equal(browserTabUnreadCount(projects, true), 3, 'count unread rows, excluding Main and archived rows')
assert.equal(browserTabUnreadCount(projects, false), 8, 'partial Agent inventory uses the authoritative summary without double-counting loaded Agents')
assert.equal(browserTabUnreadCount([], true), 0)
assert.equal(browserTabUnreadCount([{ agents: [], agentSessions: [] }], false), 0)
assert.equal(browserTabTitle('Example', 0), 'Example · Farming Code')
assert.equal(browserTabTitle('Example', 3), '(3) Example · Farming Code')
assert.equal(browserTabTitle('Renamed', 3), '(3) Renamed · Farming Code')
console.log('✓ Browser tab counts inventory rows and preserves instance titles')
