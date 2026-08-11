import assert from 'node:assert/strict'
import { readCodeStyleSource } from './style-source-reader'

const styles = readCodeStyleSource('src/styles/composer.css')
const tokens = readCodeStyleSource('src/styles/tokens.css')
for (const selector of ['.code-acp-composer', '.code-composer-send', '.code-composer-attachment']) {
  assert(styles.includes(selector), `Missing Composer rule: ${selector}`)
}
assert(!styles.includes('data-appearance'), 'Composer rules must stay appearance-neutral')
assert(tokens.includes('--code-composer-'), 'Composer colors must be owned by the shared palette')
console.log('test-composer-style-ownership passed')
