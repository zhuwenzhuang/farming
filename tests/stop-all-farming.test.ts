import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
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

function psLine(pid: number, ppid: number, command: string) {
  return `${process.getuid?.() ?? 501} ${pid} ${ppid} ${pid} Mon Aug 2 10:00:00 2026 ${command}`
}

function runMatcher(lines: string[]) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-stop-all-test-'))
  const fakePs = path.join(tempDir, 'ps')
  try {
    fs.writeFileSync(fakePs, `#!/bin/sh\ncat <<'FARMING_TEST_PS'\n${lines.join('\n')}\nFARMING_TEST_PS\n`)
    fs.chmodSync(fakePs, 0o755)
    return spawnSync('bash', [stopScript, '--dry-run'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH || ''}`,
      },
    })
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
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

test('stop-all matcher keeps supported Farming roots and their descendants', () => {
  const result = runMatcher([
    psLine(101, 1, 'node /repo/backend/farming-app-cli.cjs start'),
    psLine(102, 1, '/opt/node/bin/node /repo/backend/command-runner-child.cjs'),
    psLine(103, 1, 'node /repo/backend/native-pty-host.cjs'),
    psLine(114, 1, 'node /repo/backend/acp-runtime-host-process.cjs'),
    psLine(104, 1, 'node /repo/dist/acp/codex-acp-1.7.0.mjs --stdio'),
    psLine(105, 1, 'node /repo/bin/farming start'),
    psLine(106, 1, 'node /repo/bin/farming daemon'),
    psLine(107, 1, '/repo/bin/farming browser describe snapshot --json'),
    psLine(108, 1, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/farming-browser'),
    psLine(109, 101, '/bin/sleep 60'),
    psLine(110, 1, '/opt/glibc/ld-linux-x86-64.so.2 --library-path /opt/glibc/lib /opt/node/bin/node /repo/backend/native-pty-host.cjs'),
    psLine(111, 1, '/home/farming/.farming/glibc228/lib/ld-2.28.so --library-path /home/farming/.farming/glibc228/lib /usr/bin/node bin/farming daemon --port 3000'),
    psLine(112, 1, '/home/farming/.farming/glibc228/lib/ld-2.28.so --library-path /home/farming/.farming/glibc228/lib /usr/bin/node /srv/farming/dist/acp/codex-acp-1.7.0.mjs --stdio'),
    psLine(113, 1, '/home/farming/.farming/glibc228/lib/ld-2.28.so --library-path /home/farming/.farming/glibc228/lib /usr/bin/node backend/native-pty-host.cjs'),
  ])

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Matched 13 Farming process\(es\):/)
  for (const pid of [101, 102, 103, 104, 105, 106, 108, 109, 110, 111, 112, 113, 114]) {
    assert.match(result.stdout, new RegExp(`pid=${pid}\\b`))
  }
  assert.doesNotMatch(
    result.stdout,
    /pid=107\b/,
    'one-shot capability CLI commands must not be treated as persistent Farming processes',
  )
})

test('stop-all matcher classifies relative and absolute server roots for graceful shutdown', () => {
  const result = runMatcher([
    psLine(121, 1, 'node backend/farming-app-cli.cjs'),
    psLine(122, 1, '/opt/node/bin/node /repo/backend/farming-app-cli.cjs daemon'),
    psLine(123, 1, '/opt/glibc/lib/ld-2.28.so --library-path /opt/glibc/lib /opt/node/bin/node bin/farming daemon'),
    psLine(124, 1, 'node backend/native-pty-host.cjs'),
    psLine(125, 1, 'node backend/acp-runtime-host-process.cjs'),
  ])

  assert.equal(result.status, 0, result.stderr)
  for (const pid of [121, 122, 123]) {
    assert.match(result.stdout, new RegExp(`pid=${pid}\\b[^\\n]*shutdown=graceful`))
  }
  assert.match(result.stdout, /pid=124\b/)
  assert.doesNotMatch(result.stdout, /pid=124\b[^\n]*shutdown=graceful/)
  assert.match(result.stdout, /pid=125\b/)
  assert.doesNotMatch(result.stdout, /pid=125\b[^\n]*shutdown=graceful/)
})

test('stop-all matcher ignores Farming paths used only as unrelated arguments', () => {
  const result = runMatcher([
    psLine(201, 1, 'tail -f /repo/backend/farming-app-cli.cjs'),
    psLine(202, 1, 'code --check /repo/backend/native-pty-host.cjs'),
    psLine(203, 1, 'node /tools/checker.js /repo/backend/command-runner-child.cjs'),
    psLine(204, 1, '/bin/echo node /repo/dist/acp/codex-acp-1.7.0.mjs'),
    psLine(205, 1, '/bin/sh -c node /repo/bin/farming start'),
    psLine(206, 1, '/usr/bin/printf /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/farming-browser'),
    psLine(207, 1, 'node /repo/bin/farming status'),
    psLine(208, 1, 'node /repo/bin/farming browser status'),
  ])

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /No Farming processes found/)
  assert.doesNotMatch(result.stdout, /pid=20[1-8]\b/)
})

test('stop-all scripts remain valid bash and dry-run help remains available', () => {
  execFileSync('bash', ['-n', identityScript])
  execFileSync('bash', ['-n', stopScript])
  assert.match(execFileSync('bash', [stopScript, '--help'], { encoding: 'utf8' }), /--dry-run/)
})
