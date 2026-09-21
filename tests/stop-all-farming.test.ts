import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const projectRoot = path.join(import.meta.dirname, '..')
const identityScript = path.join(projectRoot, 'scripts', 'stop-process-identity.sh')
const stopScript = path.join(projectRoot, 'scripts', 'stop-all-farming.sh')

function runIdentityScenario(currentIdentity: string, signalExit = 0, exited = false) {
  const result = spawnSync('bash', ['-c', `
    source "$1"
    fake_identity="$2"
    fake_signal_exit="$3"
    fake_exited="$4"
    farming_read_process_identity() { printf '%s\\n' "$fake_identity"; }
    farming_process_has_exited() { [ "$fake_exited" = 1 ]; }
    farming_send_signal() {
      if [ "$fake_signal_exit" -ne 0 ]; then return "$fake_signal_exit"; fi
      printf 'signal=%s pid=%s\\n' "$1" "$2"
    }
    farming_signal_process_if_identity_matches KILL 4321 501 'Mon Aug 2 10:00:00 2026' 'node /repo/backend/farming-app-cli.cjs start'
  `, 'test-stop-identity', identityScript, currentIdentity, String(signalExit), exited ? '1' : '0'], { encoding: 'utf8' })
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
  assert.equal(result.stdout.trim(), 'signal=KILL pid=4321')
})

test('stop-all refuses a reused PID even when its command is identical', () => {
  const result = runIdentityScenario(
    '501\tMon Aug 2 10:01:00 2026\tnode /repo/backend/farming-app-cli.cjs start',
  )
  assert.equal(result.status, 3)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /process identity changed before KILL/)
})

test('stop-all refuses a process that execs a different command', () => {
  const result = runIdentityScenario(
    '501\tMon Aug 2 10:00:00 2026\tnode /tmp/unrelated.js',
  )
  assert.equal(result.status, 3)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /process identity changed before KILL/)
})

test('stop-all reports a signal failure separately from an identity change', () => {
  const result = runIdentityScenario(
    '501\tMon Aug 2 10:00:00 2026\tnode /repo/backend/farming-app-cli.cjs start',
    9,
  )
  assert.equal(result.status, 4)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /Could not send KILL to verified Farming process pid=4321/)
})

test('stop-all reconciles an exited target without an identity-change warning', () => {
  const result = runIdentityScenario('', 0, true)
  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
})

test('stop-all reports concurrent starts without selecting them for another kill', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-stop-concurrent-'))
  try {
    const script = path.join(directory, 'stop-all-farming.sh')
    const snapshot = path.join(directory, 'snapshot')
    const next = path.join(directory, 'next')
    const signals = path.join(directory, 'signals')
    fs.copyFileSync(stopScript, script)
    fs.writeFileSync(snapshot, `${psLine(41001, 1, 'node /fixture/backend/farming-app-cli.cjs')}\n`)
    fs.writeFileSync(next, `${psLine(41002, 1, 'node /fixture/backend/farming-app-cli.cjs')}\n`)
    fs.writeFileSync(path.join(directory, 'ps'), `#!/bin/sh\ncat '${snapshot}'\n`, { mode: 0o755 })
    // No real signal implementation is included in this deterministic fixture.
    fs.writeFileSync(path.join(directory, 'stop-process-identity.sh'), `
farming_signal_process_if_identity_matches() {
  printf '%s %s\\n' "$1" "$2" >> '${signals}'
  cp '${next}' '${snapshot}'
}
farming_process_identity_matches() { return 1; }
`)
    const result = spawnSync('bash', [script], {
      encoding: 'utf8', env: { ...process.env, PATH: `${directory}:${process.env.PATH || ''}` },
    })
    assert.equal(result.status, 1)
    assert.equal(fs.readFileSync(signals, 'utf8'), 'KILL 41001\n')
    assert.match(result.stderr, /concurrently started/)
    assert.match(result.stderr, /pid=41002\b/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('stop-all matcher keeps supported Farming roots and their descendants', () => {
  const result = runMatcher([
    psLine(101, 1, 'node /repo/backend/farming-app-cli.cjs start'),
    psLine(102, 1, '/opt/node/bin/node /repo/backend/command-runner-child.cjs'),
    psLine(103, 1, 'node /repo/backend/native-pty-host.cjs'),
    psLine(114, 1, 'node /repo/backend/acp-runtime-host-process.cjs'),
    psLine(104, 1, 'node /repo/dist/acp/codex-acp-1.8.0.mjs --stdio'),
    psLine(105, 1, 'node /repo/bin/farming start'),
    psLine(106, 1, 'node /repo/bin/farming daemon'),
    psLine(107, 1, '/repo/bin/farming browser describe snapshot --json'),
    psLine(108, 1, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/farming-browser'),
    psLine(109, 101, '/bin/sleep 60'),
    psLine(110, 1, '/opt/glibc/ld-linux-x86-64.so.2 --library-path /opt/glibc/lib /opt/node/bin/node /repo/backend/native-pty-host.cjs'),
    psLine(111, 1, '/home/farming/.farming/glibc228/lib/ld-2.28.so --library-path /home/farming/.farming/glibc228/lib /usr/bin/node bin/farming daemon --port 3000'),
    psLine(112, 1, '/home/farming/.farming/glibc228/lib/ld-2.28.so --library-path /home/farming/.farming/glibc228/lib /usr/bin/node /srv/farming/dist/acp/codex-acp-1.8.0.mjs --stdio'),
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

test('stop-all matcher includes relative and absolute roots with one hard-stop semantic', () => {
  const result = runMatcher([
    psLine(121, 1, 'node backend/farming-app-cli.cjs'),
    psLine(122, 1, '/opt/node/bin/node /repo/backend/farming-app-cli.cjs daemon'),
    psLine(123, 1, '/opt/glibc/lib/ld-2.28.so --library-path /opt/glibc/lib /opt/node/bin/node bin/farming daemon'),
    psLine(124, 1, 'node backend/native-pty-host.cjs'),
    psLine(125, 1, 'node backend/acp-runtime-host-process.cjs'),
  ])

  assert.equal(result.status, 0, result.stderr)
  for (const pid of [121, 122, 123, 124, 125]) {
    assert.match(result.stdout, new RegExp(`pid=${pid}\\b`))
  }
  assert.doesNotMatch(result.stdout, /shutdown=graceful/)

})

test('stop-all matcher ignores Farming paths used only as unrelated arguments', () => {
  const result = runMatcher([
    psLine(201, 1, 'tail -f /repo/backend/farming-app-cli.cjs'),
    psLine(202, 1, 'code --check /repo/backend/native-pty-host.cjs'),
    psLine(203, 1, 'node /tools/checker.js /repo/backend/command-runner-child.cjs'),
    psLine(204, 1, '/bin/echo node /repo/dist/acp/codex-acp-1.8.0.mjs'),
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

test('stop-all directly kills a creator and its detached worker without TERM hooks', { timeout: 15_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-hard-stop-'))
  const backend = path.join(directory, 'backend')
  const ready = path.join(directory, 'ready.json')
  const termMarker = path.join(directory, 'term-hook')
  const realPs = execFileSync('which', ['ps'], { encoding: 'utf8' }).trim()
  const fixture = path.join(backend, 'farming-app-cli.cjs')
  let workerPid = 0
  fs.mkdirSync(backend)
  fs.writeFileSync(fixture, `
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(termMarker)}, 'TERM'));
    if (process.argv[2] !== 'worker') {
      const worker = spawn(process.execPath, [__filename, 'worker'], { detached: true, stdio: 'ignore' });
      worker.unref();
      fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ worker: worker.pid }));
    }
    setInterval(() => {}, 1000);
  `)
  // Restrict discovery to this test's exact fixture. Identity reads still use
  // the real OS snapshot, and no other Farming instance can be selected.
  fs.writeFileSync(path.join(directory, 'ps'), `#!/bin/sh
if [ "$2" = "-axo" ]; then
  "${realPs}" "$@" | awk -v fixture='${fixture}' 'index($0, fixture)'
else
  exec "${realPs}" "$@"
fi
`)
  fs.chmodSync(path.join(directory, 'ps'), 0o755)
  const child = spawn(process.execPath, [fixture], { detached: true, stdio: 'ignore' })
  const exited = new Promise<NodeJS.Signals | null>(resolve => child.once('exit', (_code, signal) => resolve(signal)))
  try {
    const deadline = Date.now() + 5_000
    while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    assert(fs.existsSync(ready), 'fixture must publish its worker before stopping')
    workerPid = JSON.parse(fs.readFileSync(ready, 'utf8')).worker
    // A second, independent safety boundary rejects every non-fixture PID even
    // if the fake ps discovery filter breaks. Never run the global stop bare.
    const guardedStop = path.join(directory, 'stop-all-farming.sh')
    fs.copyFileSync(stopScript, guardedStop)
    fs.writeFileSync(path.join(directory, 'stop-process-identity.sh'), `${fs.readFileSync(identityScript, 'utf8')}
farming_send_signal() {
  case "$2" in
    ${child.pid}|${workerPid}) kill "-$1" "$2" ;;
    *) echo "Refusing non-fixture PID $2" >&2; return 99 ;;
  esac
}
`)
    const environment = { ...process.env, PATH: `${directory}:${process.env.PATH || ''}` }
    const preview = spawnSync('bash', [guardedStop, '--dry-run'], { encoding: 'utf8', env: environment })
    assert.equal(preview.status, 0, preview.stderr)
    assert.deepEqual([...preview.stdout.matchAll(/pid=(\d+) /g)].map(match => Number(match[1])).sort((a, b) => a - b),
      [child.pid, workerPid].sort((a, b) => Number(a) - Number(b)))
    const result = spawnSync('bash', [guardedStop], {
      encoding: 'utf8', timeout: 8_000,
      env: environment,
    })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.equal(await exited, 'SIGKILL')
    assert(!fs.existsSync(termMarker), 'intentional stop must never execute TERM hooks')
    assert.doesNotMatch(result.stdout, /graceful|unresponsive/)
    const workerState = spawnSync(realPs, ['-p', String(workerPid), '-o', 'stat='], { encoding: 'utf8' })
    assert(!workerState.stdout.trim() || /^[Z?]/.test(workerState.stdout.trim()), 'detached worker must be terminated')
  } finally {
    for (const pid of [child.pid, workerPid]) {
      if (!pid) continue
      try { process.kill(pid, 'SIGKILL') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    await exited
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
