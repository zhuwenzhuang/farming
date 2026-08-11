import assert from 'node:assert/strict'
import test from 'node:test'
import {
  browserCopy,
  resourceStatusLabel,
} from '../extensions/browser/frontend/BrowserSidebarPortals'
import type { BrowserResource } from '../extensions/browser/frontend/types'

function resource(status: BrowserResource['status'], url = 'about:blank'): BrowserResource {
  return {
    id: 'browser-1',
    ownerType: 'project',
    ownerAgentId: '',
    projectRootId: 'root-1',
    workspace: '/workspace',
    name: 'Browser',
    status,
    generation: 1,
    revision: 1,
    collectionRevision: 1,
    url,
    title: '',
    browserKind: 'chrome',
    error: '',
    createdAt: 1,
    updatedAt: 1,
  }
}

test('Browser sidebar presents transport failures as a neutral stopped tab', () => {
  assert.equal(resourceStatusLabel(resource('failed'), browserCopy('en')), 'Stopped')
  assert.equal(resourceStatusLabel(resource('failed'), browserCopy('zh')), '已停止')
})

test('Browser sidebar presents live URLs and bounded transition states', () => {
  const copy = browserCopy('en')
  assert.equal(resourceStatusLabel(resource('running', 'https://example.com/path'), copy), 'example.com/path')
  assert.equal(resourceStatusLabel(resource('starting'), copy), 'Starting…')
  assert.equal(resourceStatusLabel(resource('stopping'), copy), 'Stopping…')
  assert.equal(resourceStatusLabel(resource('stopped'), copy), 'Stopped')
})
