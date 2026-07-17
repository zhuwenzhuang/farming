const { getAgentSpec } = require('./cli-agents');
const LocalSessionEngine = require('./local-session-engine');
const NativeSessionEngine = require('./native-session-engine');

class SessionEngineRouter {
  constructor(configManager, options = {}) {
    const configDir = configManager && configManager.farmingDir;
    const preserveNativeHost = options.preserveNativeHost !== undefined
      ? options.preserveNativeHost === true
      : process.env.FARMING_NATIVE_PTY_HOST_PERSIST !== '0';
    this.engines = {
      native: new NativeSessionEngine({ configDir, preserveHostOnDispose: preserveNativeHost }),
      local: new LocalSessionEngine({ configDir })
    };
    this.overrideEngineName = process.env.FARMING_SESSION_ENGINE || '';
    this.defaultEngineName = options.defaultEngineName || this.overrideEngineName || 'native';
  }

  getEngine(name) {
    return this.engines[name] || null;
  }

  resolve(command) {
    const spec = getAgentSpec(command);

    if (!spec) {
      const engineName = this.engines[this.defaultEngineName]
        ? this.defaultEngineName
        : (this.engines.native ? 'native' : 'local');
      return {
        engine: this.engines[engineName],
        engineName,
        spec: null
      };
    }

    if (!spec.supported) {
      throw new Error(`${spec.name} is not supported in Farming yet`);
    }

    const engineName = this.overrideEngineName || spec.preferredEngine || this.defaultEngineName;
    const engine = this.getEngine(engineName);

    if (!engine) {
      throw new Error(`No session engine available for ${spec.name}`);
    }

    return {
      engine,
      engineName,
      spec
    };
  }

  dispose(options = {}) {
    const disposals = Object.values(this.engines).map((engine) => {
      if (engine && typeof engine.dispose === 'function') {
        return engine.dispose(options);
      }
      return undefined;
    });
    return Promise.allSettled(disposals);
  }
}

module.exports = SessionEngineRouter;
