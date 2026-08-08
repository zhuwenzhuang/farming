const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
}

function run() {
  const deploySource = read('scripts/deploy.sh');
  const activateSource = read('scripts/activate-remote-release.sh');
  const privateBuilderSource = read('scripts/build-private-linux-release.sh');
  const serverSource = read('backend/server.cts');
  const appCliSource = read('backend/farming-app-cli.cts');
  const npmUpdateHelperSource = read('backend/npm-update-helper.cts');
  const updateServiceSource = read('backend/update-service.cts');
  const releaseInstallerSource = read('scripts/install-release.sh');

  assert(
    !deploySource.includes('assert_safe_to_restart') &&
      !deploySource.includes('FARMING_GUARD_HTTP_URL') &&
      !deploySource.includes('FARMING_GUARD_WS_URL') &&
      activateSource.includes('run_cli "${runtime_root}" "${code_root}" stop --config-dir "${CONFIG_DIR}"') &&
      activateSource.includes("printf '%s\\n' daemon --port \"${APP_PORT}\"") &&
      !deploySource.includes('write_server_control_metadata') &&
      !activateSource.includes('kill -9') &&
      !activateSource.includes('process.kill'),
    'deploy start and stop should use the product crash-only CLI without a second process-control implementation',
  );

  assert(
    !serverSource.includes('shutdownServer') &&
      !serverSource.includes("process.on('SIGINT'") &&
      !serverSource.includes("process.on('SIGTERM'") &&
      !appCliSource.includes('signalServer') &&
      !appCliSource.includes('serverStopGraceMs') &&
      appCliSource.includes('matchingProcessIdentity(processIdentity, readServerProcessIdentity(targetPid))') &&
      appCliSource.includes('forceKillServer(pid)') &&
      appCliSource.includes("process.kill(pid, 'SIGKILL')") &&
      npmUpdateHelperSource.includes("process.kill(pid, 'SIGKILL')") &&
      releaseInstallerSource.includes('run_release_cli "${SOURCE_DIR}" stop') &&
      appCliSource.includes('this command lacks permission') &&
      npmUpdateHelperSource.includes('update helper lacks permission') &&
      !releaseInstallerSource.includes('kill -9 "${pid}"'),
    'the server should remain crash-only and stop only through a verified force-kill',
  );

  assert(
    updateServiceSource.includes("require('./server-process-identity.cjs')") &&
      npmUpdateHelperSource.includes("from './server-process-identity.cjs'") &&
      !updateServiceSource.includes("require('./farming-app-cli')") &&
      !npmUpdateHelperSource.includes("require('./farming-app-cli')"),
    'server startup must not load farming-app-cli again through the update service',
  );

  assert(
    !deploySource.includes('npm ci') &&
      !deploySource.includes('npm prune') &&
      !deploySource.includes('npm run build') &&
      deploySource.includes('build-private-linux-release.sh') &&
      deploySource.includes('verify-release-bundle.ts') &&
      deploySource.includes('rsync -a --partial --checksum'),
    'remote deployment should upload one locally built and verified artifact instead of synchronizing source',
  );

  assert(
    privateBuilderSource.includes('mktemp -d "${PROJECT_ROOT}/.tmp/private-release-worktree.XXXXXX"') &&
      !privateBuilderSource.includes('mktemp -d /tmp/') &&
      privateBuilderSource.includes('source=${WORKTREE_DIR},target=${WORKTREE_DIR}') &&
      privateBuilderSource.includes('source=${GIT_COMMON_DIR},target=${GIT_COMMON_DIR},readonly') &&
      privateBuilderSource.includes('source=${RUNTIME_CACHE_DIR},target=/farming-runtime-cache') &&
      privateBuilderSource.includes('--env GIT_CONFIG_KEY_0=safe.directory') &&
      privateBuilderSource.includes("bash -lc 'npm ci --no-audit --no-fund && npm run release:app:legacy-linux' >&2") &&
      privateBuilderSource.includes("printf '%s\\n' \"${TARBALL}\""),
    'the container builder must preserve shared paths and reserve stdout for the artifact path',
  );

  assert(
    activateSource.includes('flock -n 9') &&
      activateSource.includes('switch_current "${IMAGE_ROOT}"') &&
      activateSource.includes('The previous image was restored.') &&
      activateSource.includes('smoke-deployed-server.mjs') &&
      activateSource.indexOf('runtime prepare --config-dir "${CONFIG_DIR}" --no-activate')
        < activateSource.indexOf('stop_server "${IMAGE_ROOT}" "${IMAGE_ROOT}"'),
    'remote activation should lock, preflight, atomically select, smoke, and roll back immutable images',
  );

  assert(
    deploySource.includes('--ssh-host HOST') &&
      deploySource.includes('--ssh-user USER') &&
      deploySource.includes('--ssh-port PORT') &&
      deploySource.includes('--ssh-option KEY=VALUE') &&
      deploySource.includes('--docker-context NAME') &&
      deploySource.includes('--npm-registry URL') &&
      !deploySource.includes('ssh4'),
    'deployment should accept general OpenSSH connection parameters without environment aliases',
  );

  assert(
    releaseInstallerSource.includes('prepare_release_runtime_dependencies()') &&
      releaseInstallerSource.includes('run_release_cli "${SOURCE_DIR}" runtime prepare --config-dir "$(effective_config_dir)" --no-activate') &&
      releaseInstallerSource.includes('ensure_prerequisites\n  prepare_release_runtime_dependencies\n  stop_server'),
    'bundle installation should prepare startup dependencies before stopping the old server',
  );

  assert(
    activateSource.includes('${runtime_root}/.farming-glibc/lib/ld-2.28.so') &&
      activateSource.includes('FARMING_NODE_LD="${loader}"') &&
      activateSource.includes('FARMING_NODE_LIBRARY_PATH="$(dirname "${loader}")"'),
    'the artifact-owned compatibility runtime should launch the Server and native child hosts',
  );

  assert(
    activateSource.includes('TOKEN_FILE="${CONFIG_DIR}/.session-token"') &&
      !activateSource.includes('cat "${CONFIG_DIR}/.session-token"') &&
      !deploySource.includes('FARMING_REMOTE_TOKEN'),
    'deployment smoke should consume the persisted token file without transporting or printing the secret',
  );

  console.log('✓ remote deployment keeps one crash-only, artifact-based activation path');
}

run();
