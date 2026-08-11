import assert from 'node:assert/strict'
import { readCodeStyleSource } from './style-source-reader'

const styles = readCodeStyleSource('src/styles/usage.css')
const tokens = readCodeStyleSource('src/styles/tokens.css')
for (const selector of ['.code-usage-activity', '.code-usage-chart-summary', '.code-usage-detail-dialog']) {
  assert(styles.includes(selector), `Missing Usage rule: ${selector}`)
}
assert(!styles.includes('data-appearance'), 'Usage rules must stay appearance-neutral')
assert(tokens.includes('--code-usage-'), 'Usage colors must be owned by the shared palette')
console.log('test-usage-style-ownership passed')
