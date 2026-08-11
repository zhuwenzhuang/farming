import assert from 'node:assert/strict'
import { readCodeStyleSource } from './style-source-reader'

const styles = readCodeStyleSource('src/styles/pet.css')
const tokens = readCodeStyleSource('src/styles/tokens.css')
for (const selector of ['.code-product-pet-anchor', '.code-pet-bubble', '.code-pet-actions', '.code-pet-black-hole-rest']) {
  assert(styles.includes(selector), `Missing Pet rule: ${selector}`)
}
assert(styles.includes('@keyframes code-pet-glass-rest-appear'))
assert(!styles.includes('data-appearance'), 'Pet rules must stay appearance-neutral')
assert(tokens.includes('--code-pet-'), 'Pet colors must be owned by the shared palette')
console.log('test-pet-style-ownership passed')
