import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'

const projectRoot = path.join(import.meta.dirname, '..')
const identityScript = path.join(projectRoot, 'scripts', 'stop-process-identity.sh')
const stopScript = path.join(projectRoot, 'scripts', 'stop-all-farming.sh')

function runIdentityScenario(currentIdentity: string, signalExit = 0) {
  const result = spawnSync('bash', ['-c', `
    source "$1"
    fake_identity="$2"
    fake_signal_exit="$3"
    farming_read_process_identity() { printf '%s\\n' "$fake_identity"; }
    farming_send_signal() {
      if [ "$fake_signal_exit" -ne 0 ]; then return "$fake_signal_exit"; fi
      printf 'signal=%s pid=%s\\n' "$1" "$2"
    }
    farming_signal_process_if_identity_matches TERM 4321 501 'Mon Aug 2 10:00:00 2026' 'node /repo/backend/farming-app-cli.cjs start'
  `, 'test-stop-identity', identityScript, currentIdentity, String(signalExit)], { encoding: 'utf8' })
  return result
}

test('stop-all validates the same process identity immediately before signalling', () => {
  const result = runIdentityScenario(
    '501\tMon Aug 2 10:00:00 2026\tnode /repo/backend/farming-app-cli.cjs start',
  )
  assert.equal(result.status, 0)
  assert.equal(result.stdout.trim(), 'signal=TERM pid=4321')
})

test('stop-all refuses a reused PID even when its command is identical', () => {
  const result = runIdentityScenario(
    '501\tMon Aug 2 10:01:00 2026\tnode /repo/backend/farming-app-cli.cjs start',
  )
  assert.equal(result.status, 3)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /process identity changed before TERM/)
})

test('stop-all refuses a process that execs a different command', () => {
  const result = runIdentityScenario(
    '501\tMon Aug 2 10:00:00 2026\tnode /tmp/unrelated.js',
  )
  assert.equal(result.status, 3)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /process identity changed before TERM/)
})

test('stop-all reports a signal failure separately from an identity change', () => {
  const result = runIdentityScenario(
    '501\tMon Aug 2 10:00:00 2026\tnode /repo/backend/farming-app-cli.cjs start',
    9,
  )
  assert.equal(result.status, 4)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /Could not send TERM to verified Farming process pid=4321/)
})

test('stop-all scripts remain valid bash and dry-run help remains available', () => {
  execFileSync('bash', ['-n', identityScript])
  execFileSync('bash', ['-n', stopScript])
  assert.match(execFileSync('bash', [stopScript, '--help'], { encoding: 'utf8' }), /--dry-run/)
})
