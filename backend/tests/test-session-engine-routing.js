const assert = require('assert');
const SessionEngineRouter = require('../session-engine-router');

function run() {
  const localRouter = new SessionEngineRouter();

  try {
    const claude = localRouter.resolve('claude');
    assert.strictEqual(claude.engineName, 'native', 'claude should route to native engine by default');
    assert.strictEqual(claude.spec.supported, true, 'claude should be marked supported');

    let unsupportedError = null;
    try {
      localRouter.resolve('cursor');
    } catch (error) {
      unsupportedError = error;
    }

    assert(unsupportedError, 'cursor should be rejected by the router');
    assert(
      unsupportedError.message.includes('not supported'),
      'unsupported agent error should be user friendly'
    );

    const bash = localRouter.resolve('bash');
    assert.strictEqual(bash.engineName, 'native', 'bash should route to the native engine by default');
    assert(bash.spec, 'bash should resolve to a known shell agent spec');
    assert.strictEqual(bash.spec.category, 'other', 'bash should be grouped under other agents');
    assert.strictEqual(
      localRouter.engines.native.preserveHostOnDispose,
      true,
      'Farming runtime should keep the native pty host alive across server restarts by default'
    );

    const unknown = localRouter.resolve('totally-unknown-command');
    assert.strictEqual(unknown.engineName, 'native', 'unknown commands should fall back to native engine');
    assert.strictEqual(unknown.spec, null, 'unknown commands should not pretend to be supported agents');

    process.env.FARMING_SESSION_ENGINE = 'local';
    const overrideRouter = new SessionEngineRouter();
    try {
      assert.strictEqual(
        overrideRouter.resolve('claude').engineName,
        'local',
        'FARMING_SESSION_ENGINE should override the default engine'
      );
    } finally {
      overrideRouter.dispose();
      delete process.env.FARMING_SESSION_ENGINE;
    }

    process.env.FARMING_NATIVE_PTY_HOST_PERSIST = '0';
    const nonPersistentRouter = new SessionEngineRouter();
    try {
      assert.strictEqual(
        nonPersistentRouter.engines.native.preserveHostOnDispose,
        false,
        'FARMING_NATIVE_PTY_HOST_PERSIST=0 should opt out of persistent native pty host lifecycle'
      );
    } finally {
      nonPersistentRouter.dispose();
      delete process.env.FARMING_NATIVE_PTY_HOST_PERSIST;
    }

    console.log('✓ Session engine routing works');
  } finally {
    localRouter.dispose();
  }
}

run();
