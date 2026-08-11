import assert from 'node:assert/strict'
import { readCodeStyleSource } from './style-source-reader'

const styles = readCodeStyleSource('src/styles/settings.css')
const tokens = readCodeStyleSource('src/styles/tokens.css')
for (const selector of ['.code-settings-panel', '.code-settings-update-card', '.code-agent-home-provider']) {
  assert(styles.includes(selector), `Missing Settings rule: ${selector}`)
}
assert(styles.includes('@keyframes code-settings-mobile-enter'))
assert(!styles.includes('data-appearance'), 'Settings rules must stay appearance-neutral')
assert(tokens.includes('--code-settings-'), 'Settings colors must be owned by the shared palette')
console.log('test-settings-style-ownership passed')
