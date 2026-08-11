import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { discoverUnitTestFiles } from '../scripts/discover-unit-tests'

const repoRoot = path.join(__dirname, '..')

function readJson<T>(relativePath: string): T {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')) as T
}

const scripts = readJson<{ scripts: Record<string, string> }>('package.json').scripts

test('check gate runs typecheck, then lint, then the test suite', () => {
  const positions = ['npm run typecheck', 'npm run lint', 'npm test']
    .map(gate => {
      const index = scripts.check.indexOf(gate)
      assert.ok(index >= 0, `check must run ${gate}`)
      return index
    })
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right))
})

test('critical behavior contracts stay wired into local checks and named CI evidence', () => {
  assert.equal(scripts['test:behavior:contracts'], 'tsx scripts/check-behavior-contracts.ts')
  assert.match(scripts['test:behavior:node'], /run-behavior-node-tests\.ts/)
  assert.match(scripts['test:behavior:e2e'], /run-behavior-e2e\.ts/)
  const browserRunner = fs.readFileSync(path.join(repoRoot, 'scripts', 'run-behavior-e2e.ts'), 'utf8')
  assert.match(browserRunner, /@critical-behavior/)
  assert.match(browserRunner, /FARMING_PLAYWRIGHT_PORT/)
  assert.ok(
    scripts.check.indexOf('npm run test:behavior:contracts') < scripts.check.indexOf('npm run typecheck'),
    'check must validate behavior ownership before the broad implementation gates',
  )

  const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8')
  assert.match(workflow, /name: Critical behavior/)
  assert.match(workflow, /npm run test:behavior:node/)
  assert.match(workflow, /npm run test:behavior:e2e/)
})

test('typecheck gate keeps every required project including the strict unit tests', () => {
  const requiredProjects = [
    'tsconfig.backend-runtime.json',
    'tsconfig.backend.json',
    'tsconfig.desktop.json',
    'tsconfig.shared.json',
    'tsconfig.scripts.json',
    'tsconfig.scripts-harness.json',
    'tsconfig.tests.json',
    'tsconfig.unit-tests.json',
    'tsconfig.usage.json',
  ]
  assert.ok(scripts.typecheck.includes('tsc --noEmit'), 'typecheck must keep the frontend project')
  assert.ok(
    scripts.typecheck.includes('scripts/typecheck-classic-runtime.ts'),
    'typecheck must keep the classic browser runtime gate',
  )
  for (const project of requiredProjects) {
    assert.ok(scripts.typecheck.includes(`tsc -p ${project}`), `typecheck must run ${project}`)
    assert.ok(fs.existsSync(path.join(repoRoot, project)), `${project} must exist`)
  }
})

test('unit-test typecheck project covers every nested unit test strictly', () => {
  const unitTests = readJson<{ extends?: string; include?: string[] }>('tsconfig.unit-tests.json')
  assert.equal(unitTests.extends, './tsconfig.json')
  assert.ok(
    unitTests.include?.includes('tests/**/*.test.ts'),
    'unit-test typecheck must claim nested tests recursively, not a hand-listed set',
  )
  const base = fs.readFileSync(path.join(repoRoot, 'tsconfig.json'), 'utf8')
  assert.match(base, /"strict"\s*:\s*true/, 'unit tests inherit strict from the root project')
})

test('lint gate fails on warnings and covers every checked source scope', () => {
  assert.ok(scripts.lint.includes('--max-warnings=0'), 'lint must fail on warnings')
  const requiredPatterns = [
    'backend/**/*.cts',
    'backend/tests/test-*.ts',
    'desktop/**/*.ts',
    'extensions/*/backend/**/*.cts',
    'extensions/*/frontend/**/*.{ts,tsx}',
    'frontend/**/*.js',
    'frontend/**/*.ts',
    'scripts/**/*.ts',
    'shared/**/*.ts',
    'src/**/*.{ts,tsx}',
    'bin/farming',
  ]
  for (const pattern of requiredPatterns) {
    assert.ok(scripts.lint.includes(pattern), `lint must cover ${pattern}`)
  }
})

test('the test runner discovers unit tests automatically, including this one', () => {
  const runner = fs.readFileSync(path.join(repoRoot, 'scripts', 'run-tests.ts'), 'utf8')
  assert.match(runner, /from '\.\/discover-unit-tests'/)
  assert.match(runner, /discoverUnitTestFiles\(/)

  const discovered = discoverUnitTestFiles(path.join(repoRoot, 'tests'))
    .map(filePath => path.relative(repoRoot, filePath))
  assert.ok(discovered.includes(path.join('tests', 'quality-gate-wiring.test.ts')))
})
