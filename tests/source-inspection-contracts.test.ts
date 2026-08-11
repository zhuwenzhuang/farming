import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { inspectSourceText } from '../scripts/check-source-inspection-contracts'

const repoRoot = path.join(__dirname, '..')

test('source-inspection contract is wired and its baseline is currently valid', () => {
  const scripts = require(path.join(repoRoot, 'package.json')).scripts as Record<string, string>
  assert.match(scripts['test:behavior:contracts'], /check-source-inspection-contracts\.ts/)
  const result = execFileSync('npx', ['tsx', 'scripts/check-source-inspection-contracts.ts'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  assert.match(result, /Source-inspection contracts valid/)
})

test('source-inspection scanner follows local reader helpers, non-Source names, and aliases', () => {
  const inspections = inspectSourceText('tests/example.test.ts', `
    function read(relativePath: string) {
      return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
    }
    const contents = read('src/components/Example.tsx')
    const code = contents
    assert.ok(code.includes('Example'))
  `)
  assert.deepEqual(inspections.map(inspection => inspection.target), ['src'])
})

test('source-inspection scanner follows aliases into match and regexp test assertions', () => {
  const inspections = inspectSourceText('tests/example.test.ts', `
    const contents = fs.readFileSync(path.join(repoRoot, 'backend', 'server.cts'), 'utf8')
    const firstAlias = contents
    const secondAlias = firstAlias
    assert.match(secondAlias, /privateMethod/)
    assert.ok(/privateMethod/.test(secondAlias))
  `)
  assert.deepEqual(inspections.map(inspection => inspection.target), ['backend'])
})

test('source reads used to execute product code are not implementation-string inspections', () => {
  const inspections = inspectSourceText('tests/example.test.ts', `
    const code = fs.readFileSync(path.resolve(repoRoot, 'frontend/skins/crt/app.js'), 'utf8')
    vm.runInContext(code, sandbox)
  `)
  assert.deepEqual(inspections, [])
})
