import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import {
  inspectSourceText,
  inspectSourceTextWithLocalHelpers,
} from '../scripts/check-source-inspection-contracts'

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

test('source-inspection scanner attributes arbitrary local helper assertions to the importing test', () => {
  const modules = new Map<string, string>([
    ['tests/source-helper.ts', `
      export function assertImplementationContract() {
        const contents = fs.readFileSync(path.join(repoRoot, 'src/components/Example.tsx'), 'utf8')
        const code = contents
        assert.ok(code.includes('privateImplementation'))
      }
    `],
  ])
  const inspections = inspectSourceTextWithLocalHelpers('tests/example.test.ts', `
    import { assertImplementationContract as verify } from './source-helper'
    verify()
  `, candidate => modules.get(candidate) ?? null)
  assert.deepEqual(inspections, [{ file: 'tests/example.test.ts', line: 3, target: 'src' }])
})

test('local helpers which only execute product source do not create inspection summaries', () => {
  const modules = new Map<string, string>([
    ['tests/runtime-helper.ts', `
      export function executeRuntime() {
        const code = fs.readFileSync(path.join(repoRoot, 'frontend/skins/crt/app.js'), 'utf8')
        vm.runInContext(code, sandbox)
      }
    `],
  ])
  const inspections = inspectSourceTextWithLocalHelpers('tests/example.test.ts', `
    import { executeRuntime } from './runtime-helper'
    executeRuntime()
  `, candidate => modules.get(candidate) ?? null)
  assert.deepEqual(inspections, [])
})

test('source-inspection summaries cross two helper hops and stop circular imports', () => {
  const modules = new Map<string, string>([
    ['tests/helper-a.ts', `
      import { assertNestedContract } from './helper-b'
      export function assertSharedContract() {
        assertNestedContract()
      }
    `],
    ['tests/helper-b.ts', `
      import { assertSharedContract } from './helper-a'
      export function assertNestedContract() {
        const contents = fs.readFileSync(path.join(repoRoot, 'backend/server.cts'), 'utf8')
        assert.ok(contents.includes('privateImplementation'))
      }
      export const circularReference = assertSharedContract
    `],
  ])
  const inspections = inspectSourceTextWithLocalHelpers('tests/example.test.ts', `
    import { assertSharedContract } from './helper-a'
    assertSharedContract()
  `, candidate => modules.get(candidate) ?? null)
  assert.deepEqual(inspections, [{ file: 'tests/example.test.ts', line: 3, target: 'backend' }])
})
