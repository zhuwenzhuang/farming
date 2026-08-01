import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { discoverUnitTestFiles } from '../scripts/discover-unit-tests'

test('discovers nested unit test files deterministically and excludes Playwright specs', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-run-tests-discovery-'))
  try {
    fs.mkdirSync(path.join(fixtureRoot, 'nested'))
    fs.writeFileSync(path.join(fixtureRoot, 'b.test.ts'), '')
    fs.writeFileSync(path.join(fixtureRoot, 'a.test.ts'), '')
    fs.writeFileSync(path.join(fixtureRoot, 'nested', 'c.test.ts'), '')
    fs.writeFileSync(path.join(fixtureRoot, 'nested', 'playwright.spec.ts'), '')
    fs.writeFileSync(path.join(fixtureRoot, 'helper.ts'), '')
    assert.deepEqual(discoverUnitTestFiles(fixtureRoot), [
      path.join(fixtureRoot, 'a.test.ts'),
      path.join(fixtureRoot, 'b.test.ts'),
      path.join(fixtureRoot, 'nested', 'c.test.ts'),
    ])
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('repository discovery includes this test and never a Playwright spec', () => {
  const discovered = discoverUnitTestFiles(__dirname)
  assert.ok(discovered.includes(path.join(__dirname, 'run-tests-discovery.test.ts')))
  assert.ok(discovered.every(filePath => !filePath.endsWith('.spec.ts')))
})
