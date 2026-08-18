import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const repositoryRoot = path.resolve(import.meta.dirname, '..')

function source(relativePath: string): string {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8')
}

test('browser workspace control plane uses the shared WebSocket broker', () => {
  const sourceRoots = ['src', 'extensions/language-server/frontend']
  const files: string[] = []
  for (const sourceRoot of sourceRoots) {
    const visit = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name)
        if (entry.isDirectory()) visit(entryPath)
        else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(entryPath)
      }
    }
    visit(path.join(repositoryRoot, sourceRoot))
  }
  const forbidden = [
    /api\/language-server/,
    /api\/files\/(?:tree|search|diff|changes|branch(?:es)?|switch-branch|worktrees|history|line-changes|blame)(?:[?'"`/]|$)/,
    /api\/files\/file\?/,
  ]
  const violations = files.flatMap(filePath => {
    const body = fs.readFileSync(filePath, 'utf8')
    return forbidden.some(pattern => pattern.test(body))
      ? [path.relative(repositoryRoot, filePath)]
      : []
  })
  assert.deepStrictEqual(violations, [])

  const hook = source('src/hooks/useWebSocket.ts')
  assert.match(hook, /setWorkspaceRequestTransport\(message => sendMessage\(message\)\)/)
  assert.match(hook, /case 'workspace-result'/)
  assert.match(hook, /case 'language-server-result'/)
})

test('browser data plane remains limited to raw bytes, preview assets, and oversized saves', () => {
  const workspaceFiles = source('src/lib/workspace-files.ts')
  const apiReferences = workspaceFiles.match(/api\/files\/[A-Za-z0-9_?/${}.()'"`:-]+/g) || []
  assert(apiReferences.some(reference => reference.startsWith('api/files/raw')))
  assert(apiReferences.some(reference => reference.startsWith('api/files/previews')))
  assert(apiReferences.some(reference => reference.startsWith('api/files/file')))
  assert.strictEqual(apiReferences.length, 3)
})
