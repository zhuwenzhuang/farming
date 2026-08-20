import assert from 'node:assert/strict'
import test from 'node:test'
import { workspaceTreeDecorationBatches } from '../src/lib/workspace-files'

const encoder = new TextEncoder()

test('workspace tree decoration batches stay inside count and byte limits', () => {
  const countBounded = workspaceTreeDecorationBatches(
    'root-a',
    '',
    Array.from({ length: 4097 }, (_, index) => `entry-${index}`),
    1024 * 1024,
  )
  assert.deepStrictEqual(countBounded.map(batch => batch.length), [4096, 1])

  const maxRequestBytes = 1024
  const byteBounded = workspaceTreeDecorationBatches(
    'root-a',
    'src',
    Array.from({ length: 40 }, (_, index) => `src/${'发布'.repeat(20)}-${index}.ts`),
    maxRequestBytes,
  )
  assert(byteBounded.length > 1)
  for (const entryPaths of byteBounded) {
    const request = { operation: 'tree-decorations', rootId: 'root-a', path: 'src', entryPaths }
    assert(encoder.encode(JSON.stringify(request)).byteLength <= maxRequestBytes)
    assert(entryPaths.length <= 4096)
  }
  assert.deepStrictEqual(byteBounded.flat(), Array.from(
    { length: 40 },
    (_, index) => `src/${'发布'.repeat(20)}-${index}.ts`,
  ))
})
