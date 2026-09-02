import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const lineageScript = path.join(repositoryRoot, 'scripts', 'verify-release-lineage.sh')

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function commitFile(repository: string, fileName: string, contents: string, message: string) {
  fs.writeFileSync(path.join(repository, fileName), contents)
  git(repository, ['add', fileName])
  git(repository, ['commit', '-qm', message])
  return git(repository, ['rev-parse', 'HEAD'])
}

function createRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-release-lineage-'))
  git(root, ['init', '-q', '--initial-branch=main'])
  git(root, ['config', 'core.hooksPath', '/dev/null'])
  git(root, ['config', 'user.email', 'farming@example.test'])
  git(root, ['config', 'user.name', 'Farming Test'])
  fs.mkdirSync(path.join(root, 'scripts'))
  fs.copyFileSync(lineageScript, path.join(root, 'scripts', 'verify-release-lineage.sh'))
  const base = commitFile(root, 'base.txt', 'base\n', 'base')
  git(root, ['update-ref', 'refs/remotes/origin/main', base])
  return { root, base }
}

function runLineage(
  repository: string,
  candidate: string,
  integrationRef: string | null = 'refs/remotes/origin/main',
) {
  const env = { ...process.env }
  if (integrationRef === null) delete env.FARMING_RELEASE_INTEGRATION_REF
  else env.FARMING_RELEASE_INTEGRATION_REF = integrationRef
  return spawnSync('bash', [path.join(repository, 'scripts', 'verify-release-lineage.sh'), candidate], {
    cwd: repository,
    encoding: 'utf8',
    env,
  })
}

test('release lineage accepts a candidate reachable from authoritative main', () => {
  const { root } = createRepository()
  try {
    const candidate = commitFile(root, 'integrated.txt', 'integrated\n', 'integrated')
    git(root, ['update-ref', 'refs/remotes/origin/main', candidate])
    const result = runLineage(root, candidate)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, new RegExp(`candidate=${candidate}`))
    assert.match(result.stdout, /integration_ref=refs\/remotes\/origin\/main/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('release lineage rejects a side-branch-only candidate', () => {
  const { root, base } = createRepository()
  try {
    git(root, ['switch', '-qc', 'side-release'])
    const candidate = commitFile(root, 'side.txt', 'side\n', 'side release')
    git(root, ['update-ref', 'refs/remotes/origin/main', base])
    const result = runLineage(root, candidate)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /not reachable from the authoritative integration ref/)
    assert.match(result.stderr, /Merge the candidate into main/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('release lineage fails closed when authoritative main is unavailable', () => {
  const { root, base } = createRepository()
  try {
    git(root, ['update-ref', '-d', 'refs/remotes/origin/main'])
    const result = runLineage(root, base)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Authoritative release integration ref is unavailable/)
    assert.match(result.stderr, /git fetch origin/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('local packaging skips lineage when no authoritative integration ref is requested', () => {
  const { root } = createRepository()
  try {
    git(root, ['switch', '-qc', 'private-package'])
    const candidate = commitFile(root, 'private.txt', 'private\n', 'private package')
    git(root, ['update-ref', '-d', 'refs/remotes/origin/main'])
    const result = runLineage(root, candidate, null)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stderr, /Release lineage check skipped/)
    assert.match(result.stderr, /FARMING_RELEASE_INTEGRATION_REF is not set/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
