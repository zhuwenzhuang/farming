const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.join(__dirname, '../..');
const builder = path.join(projectRoot, 'scripts', 'build-private-linux-release.sh');
const deployer = path.join(projectRoot, 'scripts', 'deploy.sh');

function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { mode: 0o755 });
}

function runBuilder(endpoint, extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-builder-context-'));
  const binDir = path.join(root, 'bin');
  const dockerLog = path.join(root, 'docker.log');
  const gitLog = path.join(root, 'git.log');
  fs.mkdirSync(binDir);
  writeExecutable(path.join(binDir, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> "${dockerLog}"
if [ "$1" = "--context" ]; then shift 2; fi
if [ "$1" = "context" ] && [ "$2" = "inspect" ]; then
  printf '%s\\n' "${endpoint}"
  exit 0
fi
if [ "$1" = "info" ]; then exit 0; fi
exit 91
`);
  writeExecutable(path.join(binDir, 'git'), `#!/bin/sh
printf '%s\\n' "$*" >> "${gitLog}"
exit 73
`);
  const result = spawnSync('bash', [builder, '--docker-context', 'fixture-context'], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...extraEnv,
      PATH: `${binDir}:/usr/bin:/bin`,
    },
  });
  const outcome = {
    ...result,
    dockerCalls: fs.existsSync(dockerLog) ? fs.readFileSync(dockerLog, 'utf8') : '',
    gitCalls: fs.existsSync(gitLog) ? fs.readFileSync(gitLog, 'utf8') : '',
  };
  fs.rmSync(root, { recursive: true, force: true });
  return outcome;
}

function runDeploy(endpoint) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-deploy-context-'));
  const binDir = path.join(root, 'bin');
  const sshLog = path.join(root, 'ssh.log');
  fs.mkdirSync(binDir);
  writeExecutable(path.join(binDir, 'docker'), `#!/bin/sh
if [ "$1" = "context" ] && [ "$2" = "inspect" ]; then
  printf '%s\\n' "${endpoint}"
  exit 0
fi
exit 91
`);
  writeExecutable(path.join(binDir, 'ssh'), `#!/bin/sh
printf '%s\\n' "$*" >> "${sshLog}"
exit 92
`);
  writeExecutable(path.join(binDir, 'rsync'), '#!/bin/sh\nexit 93\n');
  const result = spawnSync('bash', [
    deployer,
    '--ssh-host', 'fixture-host',
    '--remote-dir', '/tmp/farming-fixture',
    '--docker-context', 'fixture-context',
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:/usr/bin:/bin`,
    },
  });
  const outcome = {
    ...result,
    sshCalls: fs.existsSync(sshLog) ? fs.readFileSync(sshLog, 'utf8') : '',
  };
  fs.rmSync(root, { recursive: true, force: true });
  return outcome;
}

function run() {
  const builderSource = fs.readFileSync(builder, 'utf8');
  assert.match(builderSource, /FARMING_RIPGREP_ARCHIVE_CACHE=\/farming-runtime-cache\/ripgrep/);
  assert.match(builderSource, /HOST_RIPGREP_CACHE_DIR/);

  const remote = runBuilder('ssh://builder.example.invalid');
  assert.strictEqual(remote.status, 2, remote.stderr);
  assert.match(remote.stderr, /requires a local Unix-socket Docker engine/);
  assert.match(remote.dockerCalls, /context inspect fixture-context/);
  assert.strictEqual(remote.gitCalls, '', 'remote contexts must fail before any Git or worktree operation');

  const local = runBuilder('unix:///tmp/farming-docker.sock');
  assert.strictEqual(local.status, 73, local.stderr);
  assert.match(local.gitCalls, /rev-parse HEAD/, 'a local Unix-socket context should pass the context preflight');

  const deployRemote = runDeploy('tcp://builder.example.invalid:2375');
  assert.strictEqual(deployRemote.status, 2, deployRemote.stderr);
  assert.strictEqual(deployRemote.sshCalls, '', 'deploy must reject a remote builder before contacting its SSH target');

  console.log('✓ private Linux builder rejects remote Docker contexts before Git, worktree, or SSH setup');
}

run();
