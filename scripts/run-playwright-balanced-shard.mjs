#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const playwrightCli = path.join(projectRoot, 'node_modules', '@playwright', 'test', 'cli.js')

function parseArguments(argv) {
  let project = ''
  let shard = ''
  let listSelected = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--project') {
      project = argv[index + 1] || ''
      index += 1
    } else if (argument === '--shard') {
      shard = argv[index + 1] || ''
      index += 1
    } else if (argument === '--list-selected') {
      listSelected = true
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  const shardMatch = shard.match(/^([1-9]\d*)\/([1-9]\d*)$/)
  if (!project || !shardMatch) {
    throw new Error('Usage: run-playwright-balanced-shard.mjs --project <name> --shard <index/total> [--list-selected]')
  }
  const shardIndex = Number(shardMatch[1])
  const shardTotal = Number(shardMatch[2])
  if (shardIndex > shardTotal) throw new Error(`Shard index exceeds shard total: ${shard}`)
  return { project, shardIndex, shardTotal, listSelected }
}

function listTestLocationGroups(project) {
  const result = spawnSync(process.execPath, [
    playwrightCli,
    'test',
    `--project=${project}`,
    '--list',
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
  })
  if (result.status !== 0) {
    process.stderr.write(result.stdout || '')
    process.stderr.write(result.stderr || '')
    throw new Error(`Playwright test discovery failed with exit code ${result.status}`)
  }

  const groups = []
  const byLocation = new Map()
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(/^\s+\[[^\]]+\] › (.+):(\d+):(\d+) › /)
    if (!match) continue
    const location = `${match[1]}:${match[2]}`
    let group = byLocation.get(location)
    if (!group) {
      group = { location, testCount: 0 }
      byLocation.set(location, group)
      groups.push(group)
    }
    group.testCount += 1
  }
  if (groups.length === 0) throw new Error(`Playwright discovered no tests for project ${project}`)
  return groups
}

function assignLocationGroups(groups, shardTotal) {
  const assignments = Array.from({ length: shardTotal }, () => ({
    locations: [],
    testCount: 0,
  }))
  let cursor = 0
  for (const group of groups) {
    const minimum = Math.min(...assignments.map(assignment => assignment.testCount))
    let selected = -1
    for (let offset = 0; offset < shardTotal; offset += 1) {
      const candidate = (cursor + offset) % shardTotal
      if (assignments[candidate].testCount === minimum) {
        selected = candidate
        break
      }
    }
    if (selected < 0) throw new Error('Unable to select a balanced Playwright shard')
    assignments[selected].locations.push(group.location)
    assignments[selected].testCount += group.testCount
    cursor = (selected + 1) % shardTotal
  }
  return assignments
}

function run() {
  const { project, shardIndex, shardTotal, listSelected } = parseArguments(process.argv.slice(2))
  const groups = listTestLocationGroups(project)
  const assignments = assignLocationGroups(groups, shardTotal)
  const assignment = assignments[shardIndex - 1]
  const totalTests = assignments.reduce((sum, entry) => sum + entry.testCount, 0)
  process.stdout.write(
    `Balanced Playwright shard ${shardIndex}/${shardTotal}: ${assignment.testCount}/${totalTests} tests across ${assignment.locations.length} locations\n`,
  )
  if (listSelected) {
    assignment.locations.forEach(location => process.stdout.write(`${location}\n`))
    return
  }

  const result = spawnSync(process.execPath, [
    playwrightCli,
    'test',
    `--project=${project}`,
    ...assignment.locations,
  ], {
    cwd: projectRoot,
    env: process.env,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
}

try {
  run()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
