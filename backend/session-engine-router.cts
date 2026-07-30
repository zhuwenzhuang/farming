import { getAgentSpec, type CliAgentSpec } from './cli-agents.cjs';

import { LocalSessionEngine } from './local-session-engine.cjs';
import { NativeSessionEngine } from './native-session-engine.cjs';
import type {
  RecoveredEngineSession,
  RuntimeEngineMetadata,
  SessionEngineContract,
  SessionEngineResolutionContract,
} from './agent-manager-engine-types.js';

interface ConfigManagerLike {
  farmingDir?: string;
}

type SessionRecord = RuntimeEngineMetadata;
type RecoveredSessionRecord = RecoveredEngineSession;

interface SessionEngineRouterOptions {
  defaultEngineName?: string;
  preserveNativeHost?: boolean;
}

type SessionEngineLike = SessionEngineContract;

interface SessionEngineConstructor {
  new(options?: Record<string, unknown>): SessionEngineLike;
}

type SessionEngineResolution = SessionEngineResolutionContract & {
  spec: CliAgentSpec | null;
};

class SessionEngineRouter {
  readonly engines: Record<string, SessionEngineLike>;
  readonly overrideEngineName: string;
  readonly defaultEngineName: string;

  constructor(
    configManager?: ConfigManagerLike | null,
    options: SessionEngineRouterOptions = {},
  ) {
    const configDir = configManager?.farmingDir || undefined;
    const preserveNativeHost = options.preserveNativeHost !== undefined
      ? options.preserveNativeHost === true
      : process.env.FARMING_NATIVE_PTY_HOST_PERSIST !== '0';
    this.engines = {
      native: checkedSessionEngine(
        new NativeSessionEngine({ configDir, preserveHostOnDispose: preserveNativeHost }),
        'native',
      ),
      local: checkedSessionEngine(new LocalSessionEngine({ configDir }), 'local'),
    };
    this.overrideEngineName = process.env.FARMING_SESSION_ENGINE || '';
    this.defaultEngineName = options.defaultEngineName || this.overrideEngineName || 'native';
  }

  getEngine(name: unknown): SessionEngineLike | null {
    if (typeof name !== 'string') return null;
    return this.engines[name] || null;
  }

  resolve(command: string): SessionEngineResolution {
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

  dispose(
    options: { preserveHost?: boolean } = {},
  ): Promise<PromiseSettledResult<unknown>[]> {
    const disposals = Object.values(this.engines).map((engine) => {
      if (engine && typeof engine.dispose === 'function') {
        return engine.dispose(options);
      }
      return undefined;
    });
    return Promise.allSettled(disposals);
  }
}

function isSessionEngineContract(engine: unknown): engine is SessionEngineContract {
  if (!engine || typeof engine !== 'object') return false;
  const candidate = engine as Record<string, unknown>;
  return [
    'createSession',
    'dispose',
    'getSessionPreview',
    'getSessionState',
    'killSession',
    'on',
    'sendInput',
  ].every(method => typeof candidate[method] === 'function');
}

function checkedSessionEngine(engine: unknown, engineName: string): SessionEngineContract {
  if (!isSessionEngineContract(engine)) {
    throw new Error(`Invalid ${engineName} session engine`);
  }
  return engine;
}

export type {
  RecoveredSessionRecord,
  SessionRecord,
  SessionEngineLike,
  SessionEngineResolution,
};

export {
  SessionEngineRouter,
};
