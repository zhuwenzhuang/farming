const { getAgentSpec } = require('./cli-agents');
const LocalSessionEngine = require('./local-session-engine') as SessionEngineConstructor;
const { NativeSessionEngine } = require('./native-session-engine.cjs') as {
  NativeSessionEngine: SessionEngineConstructor;
};

interface ConfigManagerLike {
  farmingDir?: string;
}

interface SessionRecord extends Record<string, unknown> {
  agentId?: string;
  cleared?: boolean;
  customTitle?: string;
  engineName?: string;
  exitedAt?: number | null;
  id?: string;
  lastActivityAt?: number;
  metadata?: SessionRecord;
  output?: string;
  outputSeq?: number;
  persistentSessionId?: string;
  pinned?: boolean;
  pinnedOrder?: number;
  previewCols?: number;
  previewRows?: number;
  previewSnapshot?: unknown;
  previewText?: string;
  projectOrder?: number;
  projectWorkspace?: string;
  provider?: string;
  providerHomeId?: string;
  providerHomePath?: string;
  providerSessionId?: string;
  providerSessionKey?: string;
  providerSessionProvider?: string;
  providerSessionResolvedAt?: number | string | null;
  providerSessionSource?: string;
  providerSessionTemporary?: boolean;
  providerSessionTitle?: string;
  providerSessionWorkspace?: string;
  reason?: string;
  renderOutput?: string;
  resized?: boolean;
  runtimeEpoch?: string;
  sessionId?: string;
  shellCommand?: string;
  shellCommandStartedAt?: number | null;
  shellLastCommand?: string;
  shellLastCommandDurationMs?: number | null;
  shellLastCommandFinishedAt?: number | null;
  shellLastCommandStartedAt?: number | null;
  startedAt?: number | null;
  state?: SessionRecord;
  stateRevision?: number;
  status?: string;
  terminalBusy?: boolean;
  terminalInputReceived?: boolean;
  terminalStatus?: SessionRecord;
  title?: string;
}

interface RecoveredSessionRecord extends SessionRecord {
  engineName: string;
  metadata: SessionRecord;
  state: SessionRecord;
}

interface SessionEngineRouterOptions {
  defaultEngineName?: string;
  preserveNativeHost?: boolean;
}

interface SessionEngineLike {
  clearBuffer?(sessionId: string, options?: unknown): SessionRecord | null | Promise<SessionRecord | null>;
  consumeRuntimeRotation?(): SessionRecord | null;
  createSession(options: unknown): unknown;
  dispose(options?: unknown): unknown;
  getSessionAttachCheckpoint?(sessionId: string): SessionRecord | null | Promise<SessionRecord | null>;
  getSessionPreview(sessionId: string): unknown;
  getSessionSource?(): string;
  getSessionState(sessionId: string): SessionRecord | null | Promise<SessionRecord | null>;
  interruptSession?(sessionId: string, input: unknown, options?: unknown): unknown;
  killSession(sessionId: string): unknown;
  on(eventName: string, listener: (payload: unknown) => void): unknown;
  recoverSessions?(options: unknown): SessionRecord[] | Promise<SessionRecord[]>;
  resizeSession?(
    sessionId: string,
    cols: number,
    rows: number,
  ): SessionRecord | null | Promise<SessionRecord | null>;
  sendInput(sessionId: string, input: unknown, options?: unknown): unknown;
  updateSessionMetadata?(sessionId: string, metadata: SessionRecord): unknown;
}

interface SessionEngineConstructor {
  new(options?: Record<string, unknown>): SessionEngineLike;
}

interface AgentSpec {
  [key: string]: unknown;
  category?: string;
  name: string;
  preferredEngine?: string;
  supported: boolean;
}

interface SessionEngineResolution {
  engine: SessionEngineLike;
  engineName: string;
  spec: AgentSpec | null;
}

class SessionEngineRouter {
  readonly engines: Record<string, SessionEngineLike>;
  readonly overrideEngineName: string;
  readonly defaultEngineName: string;

  constructor(
    configManager?: ConfigManagerLike | null,
    options: SessionEngineRouterOptions = {},
  ) {
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

  getEngine(name: unknown): SessionEngineLike | null {
    if (typeof name !== 'string') return null;
    return this.engines[name] || null;
  }

  resolve(command: string): SessionEngineResolution {
    const spec = getAgentSpec(command) as AgentSpec | null;

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

  dispose(options: unknown = {}): Promise<PromiseSettledResult<unknown>[]> {
    const disposals = Object.values(this.engines).map((engine) => {
      if (engine && typeof engine.dispose === 'function') {
        return engine.dispose(options);
      }
      return undefined;
    });
    return Promise.allSettled(disposals);
  }
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
