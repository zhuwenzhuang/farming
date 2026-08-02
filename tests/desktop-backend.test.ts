import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveDesktopServerVersion } from '../desktop/app-version'
import { buildSshTunnelArgs } from '../desktop/connection-manager'
import { validateDesktopRendererAssets } from '../desktop/gateway'
import { DesktopLifecycle } from '../desktop/lifecycle'
import { DesktopLocalBackend, LOCAL_BACKEND_ID } from '../desktop/local-backend'
import { allowsDesktopAudioPermission } from '../desktop/permissions'
import {
  normalizeDesktopBackendInput,
  publicDesktopBackendProfile,
  type StoredDesktopBackendProfile,
} from '../desktop/profile-model'
import { bearerCredential, joinUpstreamUrl } from '../desktop/upstream'
import {
  buildRemoteBootstrapScript,
  buildRemoteUploadCommand,
  normalizeDesktopReleaseRoot,
  normalizeDesktopServerVersion,
  parseRemoteServerHandshake,
} from '../desktop/remote-bootstrap'

test('desktop lifecycle coalesces route invalidations while a window is loading', () => {
  const lifecycle = new DesktopLifecycle()
  lifecycle.start()
  const initial = lifecycle.openWindow()
  assert.equal(lifecycle.invalidateRendererRoute(), true)
  assert.equal(lifecycle.invalidateRendererRoute(), true)

  const retry = lifecycle.navigationReady(initial)
  assert.equal(retry.kind, 'reload')
  if (retry.kind !== 'reload') return
  assert.equal(retry.token.routeRevision, 2)
  assert.deepEqual(lifecycle.navigationReady(retry.token), { kind: 'ready' })
  assert.deepEqual(lifecycle.snapshot(), {
    appPhase: 'running',
    loadedRouteRevision: 2,
    routeRevision: 2,
    windowGeneration: 1,
    windowPhase: 'ready',
  })
})

test('desktop lifecycle ignores stale window completion after close and reopen', () => {
  const lifecycle = new DesktopLifecycle()
  lifecycle.start()
  const stale = lifecycle.openWindow()
  lifecycle.closeWindow(stale.windowGeneration)
  const current = lifecycle.openWindow()

  assert.deepEqual(lifecycle.navigationReady(stale), { kind: 'ignore' })
  assert.deepEqual(lifecycle.navigationReady(current), { kind: 'ready' })
  assert.equal(lifecycle.snapshot().windowGeneration, 2)
})

test('desktop lifecycle makes shutdown terminal and suppresses late UI effects', () => {
  const lifecycle = new DesktopLifecycle()
  lifecycle.start()
  const navigation = lifecycle.openWindow()

  assert.equal(lifecycle.beginStop(), true)
  assert.equal(lifecycle.beginStop(), false)
  assert.equal(lifecycle.invalidateRendererRoute(), false)
  assert.deepEqual(lifecycle.navigationReady(navigation), { kind: 'ignore' })
  lifecycle.finishStop()
  assert.deepEqual(lifecycle.snapshot(), {
    appPhase: 'stopped',
    loadedRouteRevision: -1,
    routeRevision: 0,
    windowGeneration: 2,
    windowPhase: 'absent',
  })
  assert.throws(() => lifecycle.openWindow(), /Desktop is stopped/)
})

test('desktop lifecycle retries the newest route when an obsolete navigation fails', () => {
  const lifecycle = new DesktopLifecycle()
  lifecycle.start()
  const initial = lifecycle.openWindow()
  assert.deepEqual(lifecycle.navigationReady(initial), { kind: 'ready' })
  assert.equal(lifecycle.invalidateRendererRoute(), true)
  const obsolete = lifecycle.beginPendingNavigation()
  assert.ok(obsolete)
  assert.equal(lifecycle.invalidateRendererRoute(), true)

  const retry = lifecycle.navigationFailed(obsolete)
  assert.equal(retry.kind, 'reload')
  if (retry.kind !== 'reload') return
  assert.equal(retry.token.routeRevision, 2)
  assert.deepEqual(lifecycle.navigationReady(retry.token), { kind: 'ready' })
})

test('desktop lifecycle batches ready-window invalidations before navigation begins', () => {
  const lifecycle = new DesktopLifecycle()
  lifecycle.start()
  const initial = lifecycle.openWindow()
  assert.deepEqual(lifecycle.navigationReady(initial), { kind: 'ready' })

  lifecycle.invalidateRendererRoute()
  lifecycle.invalidateRendererRoute()
  const navigation = lifecycle.beginPendingNavigation()
  assert.equal(navigation?.routeRevision, 2)
  assert.equal(lifecycle.beginPendingNavigation(), null)
  assert.ok(navigation)
  assert.deepEqual(lifecycle.navigationReady(navigation), { kind: 'ready' })
})

test('ships branded PNG and macOS icon assets for the desktop application', () => {
  const assetsDir = path.join(__dirname, '..', 'desktop', 'assets')
  const png = fs.readFileSync(path.join(assetsDir, 'farming-desktop.png'))
  const icns = fs.readFileSync(path.join(assetsDir, 'Farming.icns'))
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.equal(png.readUInt32BE(16), 1024)
  assert.equal(png.readUInt32BE(20), 1024)
  assert.equal(png[25], 6, 'Desktop PNG must retain RGBA transparency for rounded macOS corners.')
  assert.equal(icns.subarray(0, 4).toString('ascii'), 'icns')
})

test('desktop development resolves its Server version from the repository manifest', () => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-desktop-version-'))
  const manifest = path.join(temporaryDir, 'package.json')
  try {
    fs.writeFileSync(manifest, JSON.stringify({ version: '2.2.37' }))
    assert.equal(resolveDesktopServerVersion('0.0', manifest), '2.2.37')
    assert.equal(resolveDesktopServerVersion('0.0.0', manifest), '2.2.37')
    assert.equal(resolveDesktopServerVersion('2.3.0', manifest), '2.3.0')
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true })
  }
})

test('local backend lifecycle coalesces start and makes stop idempotent', async () => {
  const runtime = new DesktopLocalBackend({
    configDir: '/tmp/farming-desktop-local-test',
    electronExecutable: '/unused/electron',
    resourcesPath: '/unused/resources',
    repositoryRoot: '/unused/repository',
    injectedUrl: 'http://127.0.0.1:43121/farming/',
    injectedToken: 'local-token',
  })
  const firstStart = runtime.start()
  const secondStart = runtime.start()
  assert.equal(firstStart, secondStart)
  const target = await firstStart
  assert.equal(runtime.state(), 'ready')
  assert.equal(target.profile.id, LOCAL_BACKEND_ID)
  assert.equal(target.profile.kind, 'local')
  assert.equal(target.profile.directUrl, 'http://127.0.0.1:43121')
  assert.equal(target.profile.basePath, '/farming')
  assert.equal(target.token, 'local-token')
  await Promise.all([runtime.stop(), runtime.stop()])
  assert.equal(runtime.state(), 'stopped')
})

test('normalizes an SSH backend without weakening OpenSSH host verification', () => {
  const profile = normalizeDesktopBackendInput({
    name: 'Development',
    transport: 'ssh',
    sshHost: 'dev-box',
    remotePort: 6694,
    basePath: 'farming/',
  })

  assert.equal(profile.farmingHome, '~/.farming-desktop')
  assert.equal(profile.basePath, '/farming')
  const args = buildSshTunnelArgs(profile.sshHost, '127.0.0.1', 6694, 54321)
  assert.deepEqual(args.slice(0, 8), [
    '-N', '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15',
  ])
  assert.ok(args.includes('127.0.0.1:54321:127.0.0.1:6694'))
  assert.equal(args.at(-1), 'dev-box')
  assert.equal(args.some(argument => argument.includes('StrictHostKeyChecking=no')), false)
})

test('rejects option-shaped SSH hosts and ambiguous direct URLs', () => {
  assert.throws(() => normalizeDesktopBackendInput({
    name: 'Unsafe',
    transport: 'ssh',
    sshHost: '-oProxyCommand=bad',
  }), /cannot start with a dash/)

  assert.throws(() => normalizeDesktopBackendInput({
    name: 'Direct',
    transport: 'direct',
    directUrl: 'http://127.0.0.1:3000/farming',
  }), /Base path field/)
})

test('never exposes the encrypted backend token to the renderer contract', () => {
  const stored: StoredDesktopBackendProfile = {
    id: 'backend-1',
    kind: 'remote',
    name: 'Backend',
    transport: 'direct',
    sshHost: '',
    remoteHost: '127.0.0.1',
    remotePort: 3000,
    basePath: '',
    directUrl: 'http://127.0.0.1:3000',
    farmingHome: '~/.farming-desktop',
    encryptedToken: 'ciphertext',
  }
  const profile = publicDesktopBackendProfile(stored)
  assert.equal(profile.hasToken, true)
  assert.equal('encryptedToken' in profile, false)
})

test('parses the versioned remote bootstrap handshake without exposing shell output', () => {
  const handshake = parseRemoteServerHandshake(`noise\nFARMING_DESKTOP_HANDSHAKE_BEGIN
protocolVersion=1
version=2.2.35
platform=linux
arch=amd64
farmingHomeHex=2f686f6d652f6465762f2e6661726d696e672d6465736b746f70
port=6694
basePathHex=2f6661726d696e67
tokenHex=7465737420746f6b656e
runtimeHex=7673636f64652d637573746f6d2d676c696263
FARMING_DESKTOP_HANDSHAKE_END\n`)
  assert.deepEqual(handshake, {
    protocolVersion: 1,
    version: '2.2.35',
    platform: 'linux',
    arch: 'amd64',
    farmingHome: '/home/dev/.farming-desktop',
    host: '127.0.0.1',
    port: 6694,
    basePath: '/farming',
    token: 'test token',
    runtime: 'vscode-custom-glibc',
  })
})

test('remote bootstrap reuses a validated custom glibc runtime on legacy Linux', () => {
  const script = buildRemoteBootstrapScript()
  assert.match(script, /FARMING_SERVER_CUSTOM_GLIBC_LINKER/)
  assert.match(script, /VSCODE_SERVER_CUSTOM_GLIBC_LINKER/)
  assert.match(script, /--set-interpreter/)
  assert.match(script, /LD_LIBRARY_PATH=/)
  assert.match(script, /FARMING_NODE_LD=/)
  assert.match(script, /FARMING_NODE_LIBRARY_PATH=/)
  assert.match(script, /FARMING_DESKTOP_COMPAT_GLIBC_PATH=/)
  assert.match(script, /FARMING_DESKTOP_INHERITED_LD_LIBRARY_PATH=/)
  assert.doesNotMatch(script, /--set-rpath/)
  assert.match(script, /--max-time 45/)
  assert.match(script, /mv "\$patched" "\$binary"/)
})

test('desktop release mirrors keep the same bounded HTTP checksum contract', () => {
  assert.equal(normalizeDesktopReleaseRoot('https://releases.example.test/farming/'), 'https://releases.example.test/farming')
  assert.throws(() => normalizeDesktopReleaseRoot('file:///tmp/releases'), /HTTP\(S\)/)
  assert.throws(() => normalizeDesktopReleaseRoot('https://user:secret@example.test/releases'), /without credentials/)
})

test('remote Server upload publishes only a complete checksum-verified temporary file', () => {
  const checksum = 'a'.repeat(64)
  const command = buildRemoteUploadCommand({
    farmingHome: '~/.farming-desktop',
    version: '2.2.37',
    expectedSize: 123_456,
    expectedSha256: checksum,
  })
  assert.match(command, /farming\.upload\.\$\$/)
  assert.match(command, /trap cleanup EXIT HUP INT TERM/)
  assert.match(command, /actual_size=.*wc -c/)
  assert.match(command, /actual_sha=.*sha256sum/)
  assert.ok(command.indexOf('actual_sha=') < command.indexOf('mv "$tmp" "$install_dir/farming"'))
  assert.equal(normalizeDesktopServerVersion('2.2.37'), '2.2.37')
  assert.throws(() => normalizeDesktopServerVersion('2.2.37$(touch bad)'), /invalid/)

  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-desktop-upload-'))
  try {
    const interrupted = spawnSync('sh', ['-c', buildRemoteUploadCommand({
      farmingHome: temporaryHome,
      version: '2.2.37',
      expectedSize: 4,
      expectedSha256: checksum,
    })], { input: Buffer.from('abc') })
    assert.equal(interrupted.status, 3)
    assert.match(interrupted.stderr.toString(), /size mismatch/)
    const installDir = path.join(temporaryHome, 'server', '2.2.37')
    assert.equal(fs.existsSync(path.join(installDir, 'farming')), false)
    assert.deepEqual(fs.existsSync(installDir) ? fs.readdirSync(installDir) : [], [])
  } finally {
    fs.rmSync(temporaryHome, { recursive: true, force: true })
  }
})

test('desktop renderer validation rejects a backend-base-path build before opening a window', () => {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-desktop-renderer-'))
  try {
    assert.throws(
      () => validateDesktopRendererAssets(distDir),
      /Desktop renderer is missing .*index\.html.*desktop:build/,
    )
    fs.mkdirSync(path.join(distDir, 'assets'))
    fs.writeFileSync(path.join(distDir, 'assets', 'app.js'), 'export {}\n')
    fs.writeFileSync(path.join(distDir, 'assets', 'app.css'), 'body {}\n')
    fs.writeFileSync(path.join(distDir, 'index.html'), [
      '<link rel="stylesheet" href="/assets/app.css">',
      '<script type="module" src="/assets/app.js"></script>',
    ].join('\n'))
    assert.doesNotThrow(() => validateDesktopRendererAssets(distDir))

    fs.writeFileSync(path.join(distDir, 'index.html'), '<script type="module" src="/farming/assets/app.js"></script>')
    assert.throws(
      () => validateDesktopRendererAssets(distDir),
      /wrong base path: \/farming\/assets\/app\.js/,
    )
  } finally {
    fs.rmSync(distDir, { recursive: true, force: true })
  }
})

test('maps gateway paths under a backend base path and encodes bearer credentials', () => {
  assert.equal(
    joinUpstreamUrl('http://127.0.0.1:43121/farming', '/api/settings?fresh=1').toString(),
    'http://127.0.0.1:43121/farming/api/settings?fresh=1',
  )
  assert.equal(bearerCredential('three word token'), 'dGhyZWUgd29yZCB0b2tlbg')
})

test('grants only main-frame microphone access to the exact desktop gateway origin', () => {
  const baseRequest = {
    gatewayOrigin: 'http://127.0.0.1:43121',
    isMainFrame: true,
    permission: 'media',
    requestingOrigin: 'http://127.0.0.1:43121/code/',
  }

  assert.equal(allowsDesktopAudioPermission({ ...baseRequest, mediaTypes: ['audio'] }), true)
  assert.equal(allowsDesktopAudioPermission({ ...baseRequest, mediaType: 'audio' }), true)
  assert.equal(allowsDesktopAudioPermission({ ...baseRequest, mediaTypes: ['video'] }), false)
  assert.equal(allowsDesktopAudioPermission({ ...baseRequest, mediaTypes: ['audio', 'video'] }), false)
  assert.equal(allowsDesktopAudioPermission({
    ...baseRequest,
    requestingOrigin: 'http://127.0.0.1:43122/code/',
    mediaTypes: ['audio'],
  }), false)
  assert.equal(allowsDesktopAudioPermission({ ...baseRequest, isMainFrame: false, mediaTypes: ['audio'] }), false)
  assert.equal(allowsDesktopAudioPermission({ ...baseRequest, permission: 'notifications', mediaTypes: ['audio'] }), false)
})
