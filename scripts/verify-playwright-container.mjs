#!/usr/bin/env node

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { chromium, webkit } from '@playwright/test'

const require = createRequire(import.meta.url)
const lock = require('../package-lock.json')
if (process.env.GITHUB_ACTIONS === 'true') {
  const workspace = process.env.GITHUB_WORKSPACE
  const candidate = process.env.GITHUB_SHA
  assert(workspace && candidate, 'CI browser evidence requires an exact mounted checkout')
  const gitRead = (...args) => execFileSync('git', ['-C', workspace, 'rev-parse', ...args], { encoding: 'utf8', timeout: 5_000 }).trim()
  assert.equal(gitRead('--show-toplevel'), workspace, 'Mounted checkout identity changed')
  assert.equal(gitRead('HEAD'), candidate, 'Mounted checkout differs from CI candidate')
}
const expected = process.env.FARMING_PLAYWRIGHT_IMAGE_VERSION
assert(expected, 'FARMING_PLAYWRIGHT_IMAGE_VERSION must identify the pinned CI image')
assert.equal(process.platform, 'linux', 'The mobile CI image must run Linux')
assert.equal(process.arch, 'x64', 'The pinned mobile CI image must run x64')
assert.equal(require('@playwright/test/package.json').version, expected, 'Installed Playwright differs from CI image')
assert.equal(lock.packages['node_modules/@playwright/test'].version, expected, 'Locked Playwright differs from CI image')
assert.equal(require('playwright-core/package.json').version, expected, 'Browser driver differs from CI image')
const image = JSON.parse(await fs.readFile('/ms-playwright/.docker-info', 'utf8'))
assert.equal(image.driverVersion, expected, 'Preinstalled browsers differ from CI image')
assert.equal(image.dockerImageName, `mcr.microsoft.com/playwright:v${expected}-noble`, 'Unexpected mobile CI image')
for (const [alias, family] of [['sans-serif', 'DejaVu Sans'], ['monospace', 'DejaVu Sans Mono']]) {
  const resolved = execFileSync('fc-match', ['--format=%{family}', alias], { encoding: 'utf8', timeout: 5_000 })
  assert.equal(resolved, family, `Shared Ubuntu visual font ${alias} was not restored`)
}

// Actual launch proves the shared system libraries are present. This check
// never installs dependencies or substitutes another browser on a failure.
for (const [name, engine] of Object.entries({ chromium, webkit })) {
  const executable = engine.executablePath()
  await fs.access(executable, fs.constants.X_OK)
  const browser = await engine.launch({ headless: true, timeout: 30_000 })
  try {
    const page = await browser.newPage()
    await page.setContent('<p>Farming mobile browser environment</p>')
    assert.equal(await page.locator('p').innerText(), 'Farming mobile browser environment')
    console.log(`Verified ${name}: Playwright ${expected}, ${executable}`)
  } finally {
    await browser.close()
  }
}
