const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
}

function run() {
  const deploySource = read('scripts/deploy.sh');
  const serverSource = read('backend/server.js');
  const appCliSource = read('backend/farming-app-cli.js');
  const npmUpdateHelperSource = read('backend/npm-update-helper.cts');
  const updateServiceSource = read('backend/update-service.cts');
  const releaseInstallerSource = read('scripts/install-release.sh');

  assert(
      !deploySource.includes('assert_safe_to_restart') &&
      !deploySource.includes('FARMING_GUARD_HTTP_URL') &&
      !deploySource.includes('FARMING_GUARD_WS_URL') &&
      deploySource.includes('bin/farming stop --config-dir ${control_config_dir}') &&
      deploySource.includes('bin/farming daemon --port ${REMOTE_PORT}') &&
      !deploySource.includes('write_server_control_metadata') &&
      deploySource.includes('Restart is always crash-only.') &&
      deploySource.includes('Stop is always crash-only.'),
    'deploy start and stop should use the product crash-only CLI without a second process-control implementation'
  );

  assert(
    !serverSource.includes('shutdownServer') &&
      !serverSource.includes("process.on('SIGINT'") &&
      !serverSource.includes("process.on('SIGTERM'") &&
      appCliSource.includes("process.kill(pid, 'SIGKILL')") &&
      npmUpdateHelperSource.includes("process.kill(pid, 'SIGKILL')") &&
      releaseInstallerSource.includes('run_release_cli "${SOURCE_DIR}" stop') &&
      appCliSource.includes('this command lacks permission') &&
      npmUpdateHelperSource.includes('update helper lacks permission') &&
      !releaseInstallerSource.includes('kill -9 "${pid}"'),
    'all supported Farming Server exit entry points should bypass in-process draining'
  );

  assert(
    updateServiceSource.includes("require('./server-process-identity.cjs')") &&
      npmUpdateHelperSource.includes("require('./server-process-identity.cjs')") &&
      !updateServiceSource.includes("require('./farming-app-cli')") &&
      !npmUpdateHelperSource.includes("require('./farming-app-cli')"),
    'server startup must not load farming-app-cli again through the update service'
  );

  assert(
    deploySource.includes("--exclude 'tmp/'") &&
      deploySource.includes("--exclude '.beads/'") &&
      deploySource.includes("--exclude '.gc/'") &&
      deploySource.includes("--exclude '.dolt-backup/'") &&
      deploySource.includes("--exclude 'fa-273-mol-dog-stale-db/'") &&
      deploySource.includes("--exclude 'fa-oxg-mol-dog-stale-db/'") &&
      deploySource.includes("--exclude '.git'") &&
      deploySource.includes('if [ -f ${REMOTE_DIR}/.git ]; then rm -f ${REMOTE_DIR}/.git; fi') &&
      deploySource.includes("--exclude 'releases/'"),
    'deploy script should keep generated local-only paths out of remote source sync'
  );

  assert(
    deploySource.includes('FARMING_BASE_PATH=${REMOTE_BASE_PATH} npm run build') &&
      !deploySource.includes('FARMING_BASE_PATH=${REMOTE_BASE_PATH} npx vite build'),
    'deploy script should build Code plus the CRT Markdown and Mermaid renderer bundles'
  );

  assert(
    deploySource.includes('prepare_remote_runtime_dependencies()') &&
      deploySource.includes('bin/farming runtime prepare --config-dir ${config_dir}') &&
      deploySource.includes('prepare_remote_runtime_dependencies\n  write_source_release_metadata') &&
      deploySource.indexOf('prepare_remote_runtime_dependencies\n  write_source_release_metadata')
        < deploySource.indexOf('cmd_start "$@"'),
    'source deployment should prepare startup dependencies before entering the restart window'
  );

  assert(
    releaseInstallerSource.includes('prepare_release_runtime_dependencies()') &&
      releaseInstallerSource.includes('run_release_cli "${SOURCE_DIR}" runtime prepare') &&
      releaseInstallerSource.includes(
        'ensure_prerequisites\n  prepare_release_runtime_dependencies\n  stop_server',
      ),
    'bundle installation should prepare startup dependencies before stopping the old server'
  );

	  assert(
	    deploySource.includes('source_release_metadata_b64') &&
	      deploySource.includes("git(['describe', '--tags', '--dirty', '--always'])") &&
	      deploySource.includes('function latestTaggedVersion()') &&
	      deploySource.includes("git(['tag', '--list', 'v[0-9]*', '--sort=-v:refname'])") &&
	      deploySource.includes('const packageNewerThanLatest = compareSemver(packageVersion, latestVersion) > 0;') &&
	      deploySource.includes("const suffix = packageNewerThanLatest ? '' : sourceVersionSuffix(gitDescribe, dirty);") &&
	      deploySource.includes('> ${REMOTE_DIR}/RELEASE.json') &&
	      deploySource.includes("type: 'source-deploy'"),
	    'deploy script should write latest-tag-based RELEASE.json metadata for source deployments'
	  );

  assert(
    deploySource.includes('inherited_token_b64="$(remote_token_b64)"') &&
      deploySource.indexOf('inherited_token_b64="$(remote_token_b64)"') < deploySource.indexOf('if remote_server_control_exists') &&
      deploySource.includes('elif [ -n "${inherited_token_b64}" ]; then') &&
      deploySource.includes("'${inherited_token_b64}' | base64 -d"),
    'deploy start should preserve the running server token when no explicit token is configured'
  );

  assert(
      deploySource.includes('config_dir="$(server_config_dir)"') &&
      deploySource.includes('.session-token') &&
      /printf '%s' \\"\\\$token\\" \| base64/.test(deploySource),
    'deploy token inheritance should read the persisted session token without base64-encoding a trailing newline'
  );

  assert(
    deploySource.includes('REMOTE_GLIBC_ROOT="${FARMING_REMOTE_GLIBC_ROOT:-}"') &&
      deploySource.includes('REMOTE_USE_GLIBC="${FARMING_REMOTE_USE_GLIBC:-${REMOTE_GLIBC_ROOT:+1}}"') &&
      deploySource.includes('remote_uses_glibc()') &&
      deploySource.includes('${REMOTE_GLIBC_ROOT}/lib/ld-2.28.so --library-path ${REMOTE_GLIBC_ROOT}/lib') &&
      deploySource.includes('export FARMING_NODE_LD=${REMOTE_GLIBC_ROOT}/lib/ld-2.28.so') &&
      deploySource.includes('export FARMING_NODE_LIBRARY_PATH=${REMOTE_GLIBC_ROOT}/lib'),
    'deploy start should honor the configured glibc compatibility runtime for the server and native PTY host'
  );

  assert(
    deploySource.includes('if ! remote "${REMOTE_DIR}/.farming-launcher.sh"; then') &&
      deploySource.includes('cp ${config_dir}/farming-server.pid ${PID_FILE}'),
    'deploy start should rely on the product CLI readiness and exact process-control handshake'
  );

  assert(
    deploySource.includes('REMOTE_CONFIG_DIR="${FARMING_REMOTE_CONFIG_DIR:-}"') &&
      deploySource.includes('server_config_dir()') &&
      deploySource.includes('remote_server_control_exists()') &&
      deploySource.includes('farming-server.pid') &&
      deploySource.includes('control_config_dir="$(server_config_dir)"') &&
      deploySource.includes('${stop_command} && rm -f ${PID_FILE}'),
    'deploy stop should preserve exact CLI ownership failures and remove compatibility metadata only after success'
  );

  console.log('✓ deploy restart and stop use one crash-only server termination path');
}

run();
