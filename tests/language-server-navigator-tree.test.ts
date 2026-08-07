import assert from 'node:assert/strict'
import test from 'node:test'
import {
  beginLanguageNavigatorNodeLoad,
  completeLanguageNavigatorNodeLoad,
  failLanguageNavigatorNodeLoad,
  languageNavigatorDirectoryLabel,
  languageNavigatorLocationLabel,
  toggleLanguageNavigatorNode,
  type LanguageNavigatorNode,
} from '../src/components/files/language-navigator-tree'

const source = { rootId: 'agent-a', filePath: 'App.ts', generation: 1 }

function node(key: string): LanguageNavigatorNode {
  return {
    key,
    id: key,
    name: key,
    detail: 'function',
    kind: 12,
    path: 'App.ts',
    lineNumber: 1,
    column: 1,
    source,
  }
}

function findNode(nodes: LanguageNavigatorNode[], key: string): LanguageNavigatorNode {
  for (const item of nodes) {
    if (item.key === key) return item
    if (item.children) {
      const child = findNode(item.children, key)
      if (child) return child
    }
  }
  throw new Error(`Missing hierarchy node ${key}`)
}

test('hierarchy locations stay compact while preserving useful line context', () => {
  assert.equal(languageNavigatorLocationLabel('src/main/java/example/Optimizer.java', 48), 'Optimizer.java:48')
  assert.equal(languageNavigatorLocationLabel('src\\main\\java\\example\\Optimizer.java', 9), 'Optimizer.java:9')
  assert.equal(languageNavigatorDirectoryLabel('src/main/java/com/aliyun/Optimizer.java'), '…/com/aliyun')
  assert.equal(languageNavigatorDirectoryLabel('src\\optimizer\\Optimizer.java'), 'src/optimizer')
  assert.equal(languageNavigatorDirectoryLabel('Optimizer.java'), '')
})

test('hierarchy nodes load recursively and retain cached children across collapse', () => {
  let nodes = [node('root')]
  nodes = beginLanguageNavigatorNodeLoad(nodes, 'root')
  assert.equal(nodes[0].loading, true)
  assert.equal(nodes[0].expanded, true)

  nodes = toggleLanguageNavigatorNode(nodes, 'root')
  assert.equal(nodes[0].expanded, false, 'a pending node can be collapsed without starting another request')

  nodes = completeLanguageNavigatorNodeLoad(nodes, 'root', [node('root/caller-a')])
  assert.equal(nodes[0].expanded, false, 'a late response must not reopen a node the user collapsed')
  assert.equal(nodes[0].children?.length, 1)

  nodes = toggleLanguageNavigatorNode(nodes, 'root')
  assert.equal(nodes[0].expanded, true)
  assert.equal(nodes[0].children?.length, 1, 're-expansion uses the loaded children')

  nodes = beginLanguageNavigatorNodeLoad(nodes, 'root/caller-a')
  nodes = completeLanguageNavigatorNodeLoad(nodes, 'root/caller-a', [node('root/caller-a/caller-b')])
  nodes = beginLanguageNavigatorNodeLoad(nodes, 'root/caller-a/caller-b')
  nodes = completeLanguageNavigatorNodeLoad(nodes, 'root/caller-a/caller-b', [node('root/caller-a/caller-b/caller-c')])
  nodes = beginLanguageNavigatorNodeLoad(nodes, 'root/caller-a/caller-b/caller-c')
  nodes = completeLanguageNavigatorNodeLoad(nodes, 'root/caller-a/caller-b/caller-c', [])

  assert.equal(findNode(nodes, 'root/caller-a/caller-b').children?.[0].name, 'root/caller-a/caller-b/caller-c')
  assert.deepEqual(findNode(nodes, 'root/caller-a/caller-b/caller-c').children, [], 'an empty leaf is a loaded state')
})

test('hierarchy node errors can be retried without retaining stale error text', () => {
  let nodes = [node('root')]
  nodes = beginLanguageNavigatorNodeLoad(nodes, 'root')
  nodes = failLanguageNavigatorNodeLoad(nodes, 'root', 'temporary failure')
  assert.equal(nodes[0].error, 'temporary failure')
  assert.equal(nodes[0].loading, false)

  nodes = beginLanguageNavigatorNodeLoad(nodes, 'root')
  assert.equal(nodes[0].error, undefined)
  assert.equal(nodes[0].loading, true)
  nodes = completeLanguageNavigatorNodeLoad(nodes, 'root', [])
  assert.deepEqual(nodes[0].children, [])
  assert.equal(nodes[0].error, undefined)
})
