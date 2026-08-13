import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeFileUrlPath } from '../src/lib/file-url-path'

test('file URL paths decode once without applying query-string plus semantics', () => {
  assert.equal(
    decodeFileUrlPath('io%20proxy%E5%8F%91%E5%B8%83/a%23b%3F.txt'),
    'io proxy发布/a#b?.txt',
  )
  assert.equal(decodeFileUrlPath('literal%2520name.txt'), 'literal%20name.txt')
  assert.equal(decodeFileUrlPath('literal+plus.txt'), 'literal+plus.txt')
})

test('file URL paths preserve malformed percent text as a literal filename', () => {
  assert.equal(decodeFileUrlPath('100%.txt'), '100%.txt')
})
