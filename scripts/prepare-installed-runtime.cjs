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

function runNode(args, stdio = 'inherit') {
  const executable = process.env.FARMING_NODE_BIN || process.execPath
  if (
    process.platform === 'linux'
    && process.env.FARMING_NODE_LD
    && process.env.FARMING_NODE_LIBRARY_PATH
  ) {
    run(process.env.FARMING_NODE_LD, [
      '--library-path',
      process.env.FARMING_NODE_LIBRARY_PATH,
      executable,
      ...args,
    ], stdio)
    return
  }
  run(executable, args, stdio)
}

if (process.env.FARMING_SKIP_INSTALL_RUNTIME_PREPARE === '1') process.exit(0)

if (!fs.existsSync(runtimeEntry)) {
  const executable = process.platform === 'win32' ? 'tsx.cmd' : 'tsx'
  const tsx = path.join(packageRoot, 'node_modules', '.bin', executable)
  if (!fs.existsSync(tsx)) {
    throw new Error('Farming backend runtime is not built and tsx is unavailable; cannot prepare startup dependencies.')
  }
  runNode(['--import', 'tsx', path.join(packageRoot, 'scripts', 'build-backend-runtime.ts')])
}

runNode([
  runtimeEntry,
  'runtime',
  'prepare',
  '--config-dir',
  seedDir,
  '--no-activate',
], ['inherit', 'ignore', 'inherit'])
