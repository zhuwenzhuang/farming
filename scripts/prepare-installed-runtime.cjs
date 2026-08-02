#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const packageRoot = path.resolve(__dirname, '..')
const runtimeEntry = path.join(packageRoot, 'backend', 'farming-app-cli.cjs')
const seedDir = path.join(packageRoot, '.farming-runtime-seed')

function run(command, args, stdio = 'inherit') {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    env: process.env,
    stdio,
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status || 1)
}

if (process.env.FARMING_SKIP_INSTALL_RUNTIME_PREPARE === '1') process.exit(0)

if (!fs.existsSync(runtimeEntry)) {
  const executable = process.platform === 'win32' ? 'tsx.cmd' : 'tsx'
  const tsx = path.join(packageRoot, 'node_modules', '.bin', executable)
  if (!fs.existsSync(tsx)) {
    throw new Error('Farming backend runtime is not built and tsx is unavailable; cannot prepare startup dependencies.')
  }
  run(tsx, [path.join(packageRoot, 'scripts', 'build-backend-runtime.ts')])
}

run(process.execPath, [
  path.join(packageRoot, 'bin', 'farming'),
  'runtime',
  'prepare',
  '--config-dir',
  seedDir,
  '--no-activate',
], ['inherit', 'ignore', 'inherit'])
