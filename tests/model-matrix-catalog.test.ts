import assert from 'node:assert/strict'
import test from 'node:test'
import { modelMatrixFamily } from '../src/components/code/ModelMatrixPicker'

test('matrix inventory preserves provider ordering, unfamiliar identities and model-specific efforts', () => {
  const models = [
    { value: 'future-model', label: 'Future', reasoning: [{ value: 'high', label: 'High' }] },
    { value: 'gpt-6-astra', label: 'GPT 6.0 Astra', reasoning: [
      { value: 'high', label: 'High' }, { value: 'ultra', label: 'Ultra' },
    ] },
    { value: 'gpt-5.6-sol', label: 'Sol', reasoning: [{ value: 'medium', label: 'Medium' }] },
  ]
  const rows = modelMatrixFamily(models, 'gpt-5.6-sol')!
  assert.deepEqual(rows.map(row => row.value), models.map(model => model.value))
  assert.equal(rows[0]?.variant, 'neutral')
  assert.equal(rows[1]?.variant, 'astra')
  assert.deepEqual(rows.map(row => row.reasoning), models.map(model => model.reasoning))
  assert.deepEqual(modelMatrixFamily(models, 'gpt-6-astra'), rows)
})

test('matrix does not invent cells for missing reasoning capabilities or a missing current model', () => {
  const models = [
    { value: 'plain', label: 'Plain', reasoning: [] },
    { value: 'ultra-only', label: 'Ultra only', reasoning: [{ value: 'ultra', label: 'Ultra' }] },
    { value: 'gpt-6-astra', label: 'Astra', reasoning: [{ value: 'high', label: 'High' }] },
    { value: 'future', label: 'Future', reasoning: [{ value: 'medium', label: 'Medium' }] },
  ]
  assert.deepEqual(modelMatrixFamily(models, 'gpt-6-astra')?.map(row => row.value), ['gpt-6-astra', 'future'])
  assert.equal(modelMatrixFamily(models, 'missing'), null)
  assert.equal(modelMatrixFamily(models, 'plain'), null)
})
