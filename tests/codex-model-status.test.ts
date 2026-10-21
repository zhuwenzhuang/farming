import assert from 'node:assert/strict'
import test from 'node:test'
import { codexTerminalReportsModel } from './e2e/internal/codex-model-status'

const catalog = [
  { value: 'gpt-6-luna', displayName: 'GPT 6.0 Luna' },
  { value: 'gpt-6-sol', displayName: 'GPT 6.0 Sol' },
]
const reports = (text: string, models = catalog) => codexTerminalReportsModel(text, models, 'gpt-6-luna', 'low')

test('rendered Codex status uses an exact live catalog identity and effort', () => {
  assert.equal(reports('GPT 6.0 Luna low · /workspace'), true)
  assert.equal(reports('gpt-6-luna low fast · ~/workspace'), true)
  assert.equal(reports('› Ask Codex\r\nGPT 6.0 Luna low · /workspace\r\n? for shortcuts'), true)
  assert.equal(reports('GPT 6.0 Luna high · /workspace'), false)
  assert.equal(reports('GPT 6.0 Luna Compact low · /workspace'), false)
  assert.equal(reports('gpt-6-luna-other low · /workspace'), false)
  assert.equal(reports('GPT 6.0 Luna low · /workspace', []), false)
  assert.equal(reports('GPT 6.0 Luna low · /workspace', [
    ...catalog, { value: 'other-model', displayName: 'GPT 6.0 Luna' },
  ]), false)
  assert.equal(reports('gpt-6-luna low · /workspace', [...catalog, catalog[0]]), false)
  assert.equal(reports('gpt-6-luna low · /workspace', [
    ...catalog, { value: 'other-model', displayName: 'gpt-6-luna' },
  ]), false)
})

test('only the latest native footer can authorize a low-cost turn', () => {
  assert.equal(reports('• Model changed to gpt-6-luna low'), false)
  assert.equal(reports('gpt-6-luna low · /workspace\nGPT 6.0 Sol low · /workspace'), false)
  assert.equal(reports('• Model changed to gpt-6-luna low\nGPT 6.0 Sol low · /workspace'), false)
  assert.equal(reports('GPT 6.0 Sol low · /workspace\nGPT 6.0 Luna low · /workspace'), true)
})
