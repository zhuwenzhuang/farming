import assert from 'node:assert/strict'
import { readCodeStyleSource } from './style-source-reader'

const styles = readCodeStyleSource('src/styles/file-editor.css')
const tokens = readCodeStyleSource('src/styles/tokens.css')
for (const selector of ['.code-file-editor', '.code-file-monaco', '.code-file-preview-panel', '.code-file-diff']) {
  assert(styles.includes(selector), `Missing File Editor rule: ${selector}`)
}
assert(!styles.includes('data-appearance'), 'File Editor rules must stay appearance-neutral')
assert(tokens.includes('--code-file-editor-'), 'File Editor colors must be owned by the shared palette')
console.log('test-file-editor-style-ownership passed')
