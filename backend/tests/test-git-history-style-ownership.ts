import assert from 'node:assert/strict'
import { readCodeStyleSource } from './style-source-reader'

const styles = readCodeStyleSource('src/styles/git-history.css')
const tokens = readCodeStyleSource('src/styles/tokens.css')
for (const selector of ['.code-git-history-section', '.code-git-history-entry', '.code-git-history-graph']) {
  assert(styles.includes(selector), `Missing Git History rule: ${selector}`)
}
assert(!styles.includes('data-appearance'), 'Git History rules must stay appearance-neutral')
assert(tokens.includes('--code-git-history-'), 'Git History colors must be owned by the shared palette')
console.log('test-git-history-style-ownership passed')
