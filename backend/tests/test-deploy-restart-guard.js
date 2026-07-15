const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
}

function run() {
  const deploySource = read('scripts/deploy.sh');

  assert(
    deploySource.includes('assert_safe_to_restart "$@"') &&
      deploySource.includes("const WebSocket = require('ws');") &&
      deploySource.includes('function isRestartBlockingAgent(agent)') &&
      deploySource.includes('function isRecoverableEngineAgent(agent)') &&
      deploySource.includes('function isAgentTerminalBusy(agent)') &&
      deploySource.includes("return agent && agent.engineName === 'native';") &&
      deploySource.includes('if (isRecoverableEngineAgent(agent)) return false;') &&
      deploySource.includes('if (isAgentTerminalBusy(agent)) return true;') &&
      deploySource.includes("agent.terminalStatus.activity === 'idle'") &&
      deploySource.includes("if (kind === 'codex') return isCodexRestartBlocking(agent);") &&
      deploySource.includes('const blocking = agents.filter(isRestartBlockingAgent);') &&
      deploySource.includes("FARMING_GUARD_HTTP_URL='http://127.0.0.1:${REMOTE_PORT}${REMOTE_BASE_PATH}/api/update'") &&
      deploySource.includes('payload.update.blockingAgents') &&
      deploySource.includes('HTTP restart guard unavailable; falling back to WebSocket state check.') &&
      deploySource.includes('Refusing to restart because active non-recoverable agents would be interrupted:') &&
      deploySource.includes('Retry with --force or FARMING_REMOTE_FORCE_RESTART=1') &&
      deploySource.includes('cmd_stop --force') &&
      deploySource.includes('stop [--force]'),
    'deploy script should refuse restart/stop when active non-recoverable agents would be interrupted unless forced'
  );

  assert(
    deploySource.indexOf("FARMING_GUARD_HTTP_URL='http://127.0.0.1:${REMOTE_PORT}${REMOTE_BASE_PATH}/api/update'") <
      deploySource.indexOf("FARMING_GUARD_WS_URL='ws://127.0.0.1:${REMOTE_PORT}${REMOTE_BASE_PATH}/ws'"),
    'deploy restart guard should prefer the server management API before falling back to WebSocket state'
  );

  assert(
      deploySource.indexOf("if (agent.status === 'pending') return true;") <
      deploySource.indexOf('if (isRecoverableEngineAgent(agent)) return false;') &&
      deploySource.indexOf('if (isRecoverableEngineAgent(agent)) return false;') <
        deploySource.indexOf('if (isAgentTerminalBusy(agent)) return true;'),
    'deploy restart guard should still block pending agents, then allow recoverable running agents before busy checks'
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
      deploySource.indexOf('inherited_token_b64="$(remote_token_b64)"') < deploySource.indexOf('# Stop if already running') &&
      deploySource.includes('elif [ -n "${inherited_token_b64}" ]; then') &&
      deploySource.includes("'${inherited_token_b64}' | base64 -d"),
    'deploy start should preserve the running server token when no explicit token is configured'
  );

  assert(
      /token=\\\$\(tr/.test(deploySource) &&
      deploySource.includes('FARMING_CONFIG_DIR=') &&
      deploySource.includes('config_dir=\\"\\$HOME/.farming\\"') &&
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
    deploySource.includes('Farming server failed to become healthy on ${REMOTE}:${REMOTE_PORT}.') &&
      deploySource.includes('200|401) exit 0 ;; esac') &&
      deploySource.includes('--connect-timeout 1 --max-time 2') &&
      deploySource.includes('if ! kill -0 ${started_pid} 2>/dev/null; then exit 1; fi;'),
    'deploy start should fail when the new process exits or its authenticated endpoint never becomes reachable'
  );

  assert(
    deploySource.includes('REMOTE_CONFIG_DIR="${FARMING_REMOTE_CONFIG_DIR:-}"') &&
      deploySource.includes('server_config_dir_for_pid()') &&
      deploySource.includes('write_server_control_metadata "${started_pid}"') &&
      deploySource.includes('farming-server.pid') &&
      deploySource.includes('farming-server.json') &&
      deploySource.includes('control_config_dir="$(server_config_dir_for_pid "${pid}")"') &&
      deploySource.includes('rm -f ${control_config_dir}/farming-server.pid ${control_config_dir}/farming-server.json'),
    'deploy start and stop should keep CLI server control metadata aligned with the source deployment process'
  );

  console.log('✓ deploy restart guard refuses unsafe restarts by default');
}

run();
