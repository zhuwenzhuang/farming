import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeAppBasePath,
  resolveAppBasePath,
  resolveAppPath,
} from '../src/lib/base-path'

test('runtime base path overrides a mismatched build-time base path', () => {
  const basePath = resolveAppBasePath('/farming', '/')

  assert.equal(basePath, '/farming')
  assert.equal(resolveAppPath(basePath, '/api/attachments/image'), '/farming/api/attachments/image')
  assert.equal(resolveAppPath(basePath, 'ws'), '/farming/ws')
})

test('build-time base path remains the bounded fallback when runtime config is absent', () => {
  assert.equal(resolveAppBasePath('', '/preview/'), '/preview')
  assert.equal(resolveAppBasePath('', '/'), '')
  assert.equal(normalizeAppBasePath('/nested/'), '/nested')
  assert.equal(resolveAppPath('', '/api/settings'), '/api/settings')
})
