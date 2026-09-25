import assert from 'node:assert/strict'
import test from 'node:test'
import { findComposerContextTrigger } from '../src/components/code/composer-context-trigger'

test('context completion starts at the caret without consuming surrounding text', () => {
  assert.deepEqual(findComposerContextTrigger('看 @src/模块，继续', 9), { start: 2, end: 9, query: 'src/模块' })
  assert.deepEqual(findComposerContextTrigger('（@测试', 4), { start: 1, end: 4, query: '测试' })
  assert.equal(findComposerContextTrigger('email@example.com', 17), null)
  assert.equal(findComposerContextTrigger('https://example.com/@name', 25), null)
  assert.equal(findComposerContextTrigger('参考 @file 后面', 11), null)
})
