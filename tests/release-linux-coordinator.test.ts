import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const coordinatorScript = path.join(repositoryRoot, 'scripts', 'check-linux-release-coordinator.sh')
const acceptanceScript = path.join(repositoryRoot, 'scripts', 'set-release-acceptance-status.sh')
const candidateSha = 'a'.repeat(40)
const pinnedImage = `registry.example.test/farming-computer@sha256:${'b'.repeat(64)}`

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-linux-release-coordinator-'))
  const scripts = path.join(root, 'scripts')
  const notes = path.join(root, 'release-notes')
  const config = path.join(root, '.farming')
  const fakeBin = path.join(root, 'fake-bin')
  fs.mkdirSync(scripts)
  fs.mkdirSync(notes)
  fs.mkdirSync(config)
  fs.mkdirSync(fakeBin)
  fs.copyFileSync(coordinatorScript, path.join(scripts, 'check-linux-release-coordinator.sh'))
  fs.chmodSync(path.join(scripts, 'check-linux-release-coordinator.sh'), 0o755)
  fs.writeFileSync(
    path.join(scripts, 'check-release-managed-dependency-updates.mjs'),
    'console.log("managed dependencies current")\n',
  )
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '3.4.5' }))
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages: { '': { version: '3.4.5' } } }))
  fs.writeFileSync(path.join(notes, 'v3.4.5.md'), '# Release\n')
  fs.writeFileSync(path.join(notes, 'v3.4.5.zh_cn.md'), '# 发布\n')
  fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ computerImage: pinnedImage }))

  const dispatcher = path.join(fakeBin, 'farming-release-fake-command')
  fs.writeFileSync(dispatcher, `#!/usr/bin/env bash
set -u
name="$(basename "$0")"
case "$name" in
  uname) printf '%s\\n' "\${FAKE_UNAME:-Linux}" ;;
  npm) printf '10.9.3\\n' ;;
  codex) exit 0 ;;
  docker)
    case "\${1:-}" in info|image) exit 0 ;; esac
    exit 2
    ;;
  git)
    case "$*" in
      'rev-parse --abbrev-ref HEAD') printf 'main\\n' ;;
      'rev-parse HEAD') printf '%s\\n' "${candidateSha}" ;;
      'status --porcelain --untracked-files=normal') printf '%s' "\${FAKE_DIRTY:-}" ;;
      'config --global --get http.sslVerify')
        [[ -n "\${FAKE_SSL_VERIFY:-}" ]] || exit 1
        printf '%s\\n' "$FAKE_SSL_VERIFY"
        ;;
      'config --global --get http.sslVersion')
        [[ -n "\${FAKE_SSL_VERSION:-}" ]] || exit 1
        printf '%s\\n' "$FAKE_SSL_VERSION"
        ;;
      'ls-remote origin refs/heads/main') printf '%s\\trefs/heads/main\\n' "${candidateSha}" ;;
      *) exit 2 ;;
    esac
    ;;
  gh)
    if [[ -n "\${FAKE_GH_LOG:-}" ]]; then printf '%s\\n' "$*" >> "$FAKE_GH_LOG"; fi
    if [[ "\${1:-} \${2:-}" == 'api --method' ]]; then exit 0; fi
    case "$*" in
      'auth status --hostname github.com') exit 0 ;;
      'repo view --json nameWithOwner --jq .nameWithOwner') printf 'owner/farming\\n' ;;
      'api repos/owner/farming --jq .permissions.push') printf 'true\\n' ;;
      api\\ repos/owner/farming/actions/workflows/*' --jq .state') printf 'active\\n' ;;
      *) exit 2 ;;
    esac
    ;;
  *) exit 2 ;;
esac
`)
  fs.chmodSync(dispatcher, 0o755)
  for (const name of ['uname', 'npm', 'codex', 'docker', 'git', 'gh']) {
    fs.symlinkSync(dispatcher, path.join(fakeBin, name))
  }

  return { root, fakeBin }
}

function runCoordinator(root: string, fakeBin: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync('bash', [path.join(root, 'scripts', 'check-linux-release-coordinator.sh'), '3.4.5'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...extraEnv,
      HOME: root,
      PATH: `${fakeBin}:${process.env.PATH}`,
    },
  })
}

test('Linux coordinator preflight keeps artifacts in GitHub Actions and records the iOS exception', () => {
  const { root, fakeBin } = createFixture()
  try {
    const result = runCoordinator(root, fakeBin)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /artifact_execution=github-actions/)
    assert.match(result.stdout, /npm_publication=github-actions-oidc/)
    assert.match(result.stdout, /ios_acceptance=skipped/)
    assert.match(result.stdout, /ios_acceptance_reason=linux-coordinator-special-rule/)
    assert.match(result.stdout, /preflight=ready/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Linux coordinator preflight fails closed for unsafe Git TLS and dirty release input', () => {
  const { root, fakeBin } = createFixture()
  try {
    const unsafeTls = runCoordinator(root, fakeBin, { FAKE_SSL_VERIFY: 'false' })
    assert.notEqual(unsafeTls.status, 0)
    assert.match(unsafeTls.stderr, /http\.sslVerify=false must be removed/)

    const dirty = runCoordinator(root, fakeBin, { FAKE_DIRTY: ' M package.json\n' })
    assert.notEqual(dirty.status, 0)
    assert.match(dirty.stderr, /uncommitted changes/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Linux acceptance status makes the iOS skip auditable', () => {
  const { root, fakeBin } = createFixture()
  const ghLog = path.join(root, 'gh.log')
  try {
    const result = spawnSync(
      'bash',
      [acceptanceScript, 'success', '3.4.5', 'campaign-1', candidateSha],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: root,
          PATH: `${fakeBin}:${process.env.PATH}`,
          FAKE_GH_LOG: ghLog,
        },
      },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /coordinator_platform=linux/)
    assert.match(result.stdout, /ios_acceptance=skipped-linux-coordinator-rule/)
    assert.match(fs.readFileSync(ghLog, 'utf8'), /iOS skipped by Linux coordinator rule/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('non-Linux acceptance keeps iOS selected by the changed-area policy', () => {
  const { root, fakeBin } = createFixture()
  try {
    const result = spawnSync(
      'bash',
      [acceptanceScript, 'success', '3.4.5', 'campaign-2', candidateSha],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: root,
          PATH: `${fakeBin}:${process.env.PATH}`,
          FAKE_UNAME: 'Darwin',
        },
      },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /coordinator_platform=darwin/)
    assert.match(result.stdout, /ios_acceptance=selected-by-change/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
