import assert from 'node:assert/strict'
import test from 'node:test'
import { TargetBindingRegistry } from '../extensions/language-server/frontend/target-binding-registry'

test('target bindings are released with their source model', () => {
  const registry = new TargetBindingRegistry<{ rootId: string }>()
  registry.set('model-a', 'target-a', { rootId: 'agent-a' })
  registry.set('model-a', 'target-shared', { rootId: 'agent-a' })
  assert.equal(registry.size, 2)

  registry.deleteSource('model-a')

  assert.equal(registry.size, 0)
  assert.equal(registry.get('target-a'), undefined)
  assert.equal(registry.get('target-shared'), undefined)
})

test('disposing an old source cannot delete a target rebound by a live model', () => {
  const registry = new TargetBindingRegistry<{ rootId: string }>()
  registry.set('model-a', 'target-shared', { rootId: 'agent-a' })
  registry.set('model-b', 'target-shared', { rootId: 'agent-b' })

  registry.deleteSource('model-a')
  assert.deepEqual(registry.get('target-shared'), { rootId: 'agent-b' })
  assert.equal(registry.size, 1)

  registry.deleteSource('model-b')
  assert.equal(registry.size, 0)
})

test('disposing the newer source keeps the target alive for the original source', () => {
  const registry = new TargetBindingRegistry<{ rootId: string }>()
  registry.set('model-a', 'target-b', { rootId: 'agent-a' })
  registry.set('model-b', 'target-b', { rootId: 'agent-b' })

  // model-b is disposed first; target-b must survive for model-a's opener.
  registry.deleteSource('model-b')
  assert.deepEqual(registry.get('target-b'), { rootId: 'agent-b' })
  assert.equal(registry.size, 1)

  registry.deleteSource('model-a')
  assert.equal(registry.get('target-b'), undefined)
  assert.equal(registry.size, 0)
})
