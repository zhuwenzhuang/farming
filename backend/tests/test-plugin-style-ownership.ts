import assert from 'node:assert/strict'
import { readCodeStyleSource } from './style-source-reader'

const styles = readCodeStyleSource('src/styles/plugin.css')
const tokens = readCodeStyleSource('src/styles/tokens.css')
for (const selector of ['.code-plugin-view', '.code-plugin-card', '.code-plugin-manifest-icon']) {
  assert(styles.includes(selector), `Missing Plugin rule: ${selector}`)
}
assert(!styles.includes('data-appearance'), 'Plugin rules must stay appearance-neutral')
assert(tokens.includes('--code-plugin-'), 'Plugin colors must be owned by the shared palette')
console.log('test-plugin-style-ownership passed')
