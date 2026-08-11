import assert from 'node:assert/strict'
import { readCodeStyleSource } from './style-source-reader'

const styles = readCodeStyleSource('src/styles/markdown.css')
const tokens = readCodeStyleSource('src/styles/tokens.css')
for (const selector of ['.code-markdown-preview', '.code-markdown-mermaid', '.code-markdown-frontmatter']) {
  assert(styles.includes(selector), `Missing Markdown rule: ${selector}`)
}
assert(!styles.includes('data-appearance'), 'Markdown rules must stay appearance-neutral')
assert(tokens.includes('--code-markdown-'), 'Markdown colors must be owned by the shared palette')
console.log('test-markdown-style-ownership passed')
