const path = require('path');
const SessionEngine = require('./session-engine');
const TerminalScreenWorkerPool = require('./terminal-screen-worker-pool');
const {
  applyShellBusyIntegration,
  cleanupShellBusyIntegration,
  parseShellBusyMarkers,
} = require('./shell-busy-integration');
const { terminalInputToPtyString } = require('./input-parts');
const { deriveTerminalStatus } = require('./terminal-status');
const { normalizeInteractiveTerminalEnv } = require('./agent-env');
const {
  allocateNativePtyRuntimeGeneration,
  formatNativePtyRuntimeEpoch,
} = require('./native-pty-controller-generation');
const storageLayout = require('./storage-layout');
const {
  beginTerminalGeometryResize,
  claimTerminalGeometry,
  commitTerminalGeometryResize,
  createTerminalGeometryControl,
  expireTerminalGeometryIfNeeded,
  rejectTerminalGeometryResize,
  releaseTerminalGeometry,
  renewTerminalGeometry,
  validateTerminalGeometryClear,
  validateTerminalGeometryInput,
  validateTerminalGeometryOutputAck,
  validateTerminalGeometryRendererReady,
} = require('./terminal-geometry-control');
const {
  acknowledgeTerminalReducerData,
  acknowledgeTerminalRendererData,
  createTerminalReducerFlowControl,
  ensureTerminalReducerFlowControl,
  enqueueTerminalReducerData,
  enqueueTerminalRendererData,
  resetTerminalReducerFlowControl,
  resetTerminalRendererFlowControl,
  setTerminalExternalFlowControlBlocked,
} = require('./terminal-reducer-flow-control');
const {
  captureTerminalAttachCheckpoint,
} = require('./terminal-attach-checkpoint');

const CONTROLLED_BASH_PROMPT = [
  '\\[\\e[90m\\]│\\[\\e[0m\\] ',
  '\\[\\e[34m\\]\\W',
  '\\[\\e[90m\\] \\$ ',
  '\\[\\e[0m\\]',
].join('');

const CONTROLLED_ZSH_PROMPT = [
  '%F{8}│%f ',
  '%F{4}%1~',
  '%F{8} %# ',
  '%f',
].join('');

const CONTROLLED_ANON_BASH_PROMPT = '\\[\\e[90m\\]│ \\$ \\[\\e[0m\\]';
const CONTROLLED_ANON_ZSH_PROMPT = '%F{8}│ %# %f';
const INHERITED_PROMPT_ENV_KEYS = [
  'PS1',
  'PS2',
  'PS3',
  'PS4',
  'PROMPT',
  'RPROMPT',
  'RPS1',
  'PROMPT_COMMAND',
];

function stripInheritedPromptEnv(env) {
  for (const key of INHERITED_PROMPT_ENV_KEYS) {
    delete env[key];
  }
}

function extractLatestTerminalTitle(data) {
  if (!data) return null;

  const TITLE_PATTERN = /\x1b\]([012]);([^\x07\x1b]*?)(?:\x07|\x1b\\)/g;
  let match = null;
  let latestTitle = null;

  while ((match = TITLE_PATTERN.exec(data)) !== null) {
    const mode = match[1];
    const title = match[2] ? match[2].trim() : '';
    if ((mode === '0' || mode === '2') && title) {
      latestTitle = title;
    }
  }

  return latestTitle;
}

let cachedPty = null;
let cachedPtyError = null;

function loadPtyModule() {
  if (cachedPty) return cachedPty;
  if (cachedPtyError) throw cachedPtyError;
  try {
    cachedPty = require('./packaged-node-pty');
    return cachedPty;
  } catch (error) {
    cachedPtyError = error;
    throw error;
  }
}

function createPtyProcess(command, args, options) {
  try {
    return loadPtyModule().spawn(command, args || [], options);
  } catch (error) {
    const wrapped = new Error(`Farming requires node-pty to start interactive agents. Native PTY is unavailable: ${error.message}`);
    wrapped.cause = error;
    throw wrapped;
  }
}

function normalizeShellSessionOptions(options) {
  const normalized = {
    ...options,
    args: [...(options.args || [])],
    env: {
      ...(options.env || process.env)
    }
  };

  normalizeInteractiveTerminalEnv(normalized.env, {
    stripRuntimeShims: false,
    stripNodeOptions: false,
  });

  if (options.category === 'coding') {
    // Run coding agents directly to avoid user shell init side effects
    // (aliases, prompts, startup scripts, TERM mutations) that can break
    // interactive TUI bootstrapping on specific local machines.
    normalized.command = options.command;
    normalized.args = [...(options.args || [])];
    return normalized;
  }

  if (options.category !== 'other') {
    return normalized;
  }

  const shellName = path.basename(options.command || '');
  // Match VS Code's terminal contract: a normal shell starts as the user's
  // interactive shell. Farming's OSC markers observe it without owning PS1.
  // The compact prompt remains an explicit privacy / screenshot mode only.
  const useControlledPrompt = normalized.env.FARMING_SHELL_CONTROLLED_PROMPT === '1'
    || normalized.env.FARMING_ANONYMIZE_SHELL_PROMPT === '1';
  const useAnonymousPrompt = normalized.env.FARMING_ANONYMIZE_SHELL_PROMPT === '1';

  if (useControlledPrompt) stripInheritedPromptEnv(normalized.env);

  if (shellName === 'bash') {
    normalized.args = normalized.args.length > 0 ? normalized.args : [];
    if (useControlledPrompt) {
      normalized.env.FARMING_SHELL_CONTROLLED_PROMPT = '1';
      normalized.env.PS1 = useAnonymousPrompt ? CONTROLLED_ANON_BASH_PROMPT : CONTROLLED_BASH_PROMPT;
    }
    normalized.env.BASH_SILENCE_DEPRECATION_WARNING = normalized.env.BASH_SILENCE_DEPRECATION_WARNING || '1';
  } else if (shellName === 'zsh') {
    normalized.args = normalized.args.length > 0 ? normalized.args : [];
    if (useControlledPrompt) {
      normalized.env.FARMING_SHELL_CONTROLLED_PROMPT = '1';
      normalized.env.PROMPT = useAnonymousPrompt ? CONTROLLED_ANON_ZSH_PROMPT : CONTROLLED_ZSH_PROMPT;
      normalized.env.PS1 = normalized.env.PROMPT;
    }
  }

  normalized.env.SHELL = normalized.env.SHELL || options.command || shellName;

  return applyShellBusyIntegration(normalized);
}

class LocalSessionEngine extends SessionEngine {
  constructor(options = {}) {
    super();
    this.configDir = options.configDir || storageLayout.farmingConfigDir();
    this.sessions = new Map();
    this.screenWorkerPool = new TerminalScreenWorkerPool({
      size: 3,
      workerOptions: {
        cols: 80,
        rows: 30,
        previewSnapshot: false,
      },
    });
  }

  async createSession(options) {
    const normalized = normalizeShellSessionOptions(options);
    const previewCols = normalized.cols || 80;
    const previewRows = normalized.rows || 30;
    const runtimeGeneration = await allocateNativePtyRuntimeGeneration(this.configDir);
    const runtimeEpoch = formatNativePtyRuntimeEpoch(runtimeGeneration);
    const screenWorker = await this.screenWorkerPool.acquire({
      cols: previewCols,
      rows: previewRows,
      runtimeEpoch,
      runtimeGeneration,
    });

    let ptyProcess;
    try {
      ptyProcess = createPtyProcess(normalized.command, normalized.args || [], {
        name: 'xterm-256color',
        cols: previewCols,
        rows: previewRows,
        cwd: normalized.cwd,
        env: normalized.env || process.env
      });
    } catch (error) {
      cleanupShellBusyIntegration(normalized.shellBusyIntegration);
      await screenWorker.dispose().catch(() => {});
      throw error;
    }

    const session = {
      id: normalized.agentId,
      command: normalized.command,
      args: normalized.args || [],
      cwd: normalized.cwd,
      process: ptyProcess,
      output: '',
      outputSeq: 0,
      stateRevision: 0,
      runtimeEpoch,
      stateProofAvailable: true,
      reducerFlowControl: createTerminalReducerFlowControl(),
      reducerCommitQueue: Promise.resolve(),
      geometryControl: createTerminalGeometryControl(),
      renderOutput: '',
      previewText: '',
      previewSnapshot: null,
      previewCols,
      previewRows,
      title: '',
      status: 'running',
      terminalBusy: null,
      shellCwd: '',
      shellLastExitCode: null,
      shellLastEvent: '',
      shellCommand: '',
      shellLastCommand: '',
      shellCommandStartedAt: null,
      shellLastCommandStartedAt: null,
      shellLastCommandFinishedAt: null,
      shellLastCommandDurationMs: null,
      shellBusyMarkerPending: '',
      shellBusyIntegration: normalized.shellBusyIntegration || null,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      screenWorker
    };

    session.screenWorker.on('preview', ({ previewText, title, cols, rows, previewSnapshot }) => {
      const current = this.sessions.get(session.id);
      if (!current) return;

      current.previewText = previewText || '';
      current.previewSnapshot = previewSnapshot || null;
      current.previewCols = cols || current.previewCols;
      current.previewRows = rows || current.previewRows;

      if (title && title !== current.title) {
        current.title = title;
        this.emit('session-title', {
          sessionId: current.id,
          title: current.title
        });
      }

      this.emit('session-preview', {
        sessionId: current.id,
        previewText: current.previewText,
        cols: current.previewCols,
        rows: current.previewRows,
        previewSnapshot: current.previewSnapshot,
      });
    });

    session.screenWorker.on('error', (error) => {
      this.failSessionScreenState(session, error);
    });

    this.sessions.set(session.id, session);
    this.emit('session-started', {
      sessionId: session.id,
      status: session.status,
      startedAt: session.startedAt,
      runtimeEpoch: session.runtimeEpoch,
      stateRevision: session.stateRevision
    });

    ptyProcess.onData(data => this.handleSessionData(session.id, data));

    ptyProcess.onExit(({ code }) => {
      const current = this.sessions.get(session.id);
      if (!current) return;

      current.screenWorker.getState().catch(() => ({
        renderOutput: current.renderOutput,
        previewText: current.previewText,
        previewSnapshot: current.previewSnapshot,
        title: current.title
      })).then((screenState) => {
        const latest = this.sessions.get(session.id);
        if (!latest) return;

        latest.status = 'exited';
        latest.exitedAt = Date.now();
        resetTerminalReducerFlowControl(
          ensureTerminalReducerFlowControl(latest),
          latest.process,
        );
        latest.renderOutput = screenState.renderOutput || latest.renderOutput;
        latest.previewText = screenState.previewText || latest.previewText || latest.output.slice(-2000);
        latest.previewSnapshot = screenState.previewSnapshot || latest.previewSnapshot;
        latest.previewCols = screenState.cols || latest.previewCols;
        latest.previewRows = screenState.rows || latest.previewRows;
        latest.title = screenState.title || latest.title;
        if (latest.screenWorker) {
          latest.screenWorker.dispose().catch(() => {});
          latest.screenWorker = null;
        }
        cleanupShellBusyIntegration(latest.shellBusyIntegration);

        this.emit('session-exited', {
          sessionId: latest.id,
          code,
          exitedAt: latest.exitedAt
        });
        this.emit('session-preview', {
          sessionId: latest.id,
          previewText: latest.previewText,
          cols: latest.previewCols,
          rows: latest.previewRows,
          previewSnapshot: latest.previewSnapshot,
        });
      });
    });

    return {
      sessionId: session.id,
      status: session.status
    };
  }

  handleSessionData(sessionId, rawData) {
    const current = this.sessions.get(sessionId);
    if (!current || current.stateProofAvailable === false) return;

    const busyState = parseShellBusyMarkers(
      rawData,
      current.terminalBusy,
      current.shellBusyMarkerPending,
    );
    current.shellBusyMarkerPending = busyState.pending;
    if (busyState.markerSeen) {
      const markerAt = Date.now();
      current.terminalBusy = busyState.terminalBusy;
      if (busyState.cwd) current.shellCwd = busyState.cwd;
      if (busyState.exitCodeSeen) current.shellLastExitCode = busyState.lastExitCode;
      if (busyState.shellEvent) current.shellLastEvent = busyState.shellEvent;
      if (busyState.shellEvent === 'start') current.shellCommandStartedAt = markerAt;
      if (busyState.commandTextSeen) current.shellCommand = busyState.shellCommand || '';
      if (busyState.shellEvent === 'finish') {
        const commandStartedAt = current.shellCommandStartedAt;
        if (current.shellCommand) current.shellLastCommand = current.shellCommand;
        if (typeof commandStartedAt === 'number') {
          current.shellLastCommandStartedAt = commandStartedAt;
          current.shellLastCommandFinishedAt = markerAt;
          current.shellLastCommandDurationMs = Math.max(0, markerAt - commandStartedAt);
        }
        current.shellCommand = '';
        current.shellCommandStartedAt = null;
      }
      this.emit('session-busy-state', {
        sessionId: current.id,
        terminalBusy: current.terminalBusy,
        cwd: current.shellCwd || current.cwd,
        lastExitCode: current.shellLastExitCode,
        shellEvent: current.shellLastEvent,
        shellCommand: current.shellCommand,
        shellLastCommand: current.shellLastCommand,
        shellCommandStartedAt: current.shellCommandStartedAt,
        shellLastCommandStartedAt: current.shellLastCommandStartedAt,
        shellLastCommandFinishedAt: current.shellLastCommandFinishedAt,
        shellLastCommandDurationMs: current.shellLastCommandDurationMs,
        statusMarkerSeen: busyState.statusMarkerSeen,
        busyMarkerSeen: busyState.busyMarkerSeen,
      });
    }

    const data = busyState.data;
    if (!data) return;
    const reducerDelivery = enqueueTerminalReducerData(
      ensureTerminalReducerFlowControl(current),
      current.process,
      data,
    );
    if (reducerDelivery.error) {
      this.failSessionScreenState(current, reducerDelivery.error);
      return;
    }
    current.outputSeq += 1;
    current.stateRevision += 1;
    const outputSeq = current.outputSeq;
    const stateRevision = current.stateRevision;
    current.output = `${current.output}${data}`.slice(-10000);
    current.lastActivityAt = Date.now();

    const fallbackTitle = extractLatestTerminalTitle(data);
    if (fallbackTitle && fallbackTitle !== current.title) {
      current.title = fallbackTitle;
      this.emit('session-title', {
        sessionId: current.id,
        title: current.title,
      });
    }

    const commit = current.screenWorker.append(data, stateRevision, outputSeq);
    current.reducerCommitQueue = current.reducerCommitQueue.then(() => commit).then(() => {
      const latest = this.sessions.get(current.id);
      if (latest !== current || latest.stateProofAvailable === false) return;
      const rendererFlowError = this.trackSessionRendererData(latest, data);
      if (rendererFlowError) {
        this.failSessionScreenState(latest, rendererFlowError);
        return;
      }
      const flowError = acknowledgeTerminalReducerData(
        ensureTerminalReducerFlowControl(latest),
        latest.process,
        reducerDelivery.bytes,
      );
      if (flowError) {
        this.failSessionScreenState(latest, flowError);
        return;
      }
      this.emit('session-output', {
        sessionId: latest.id,
        data,
        runtimeEpoch: latest.runtimeEpoch,
        outputSeq,
        stateRevision,
      });
      this.emit('session-activity', {
        sessionId: latest.id,
        lastActivityAt: latest.lastActivityAt,
      });
    }).catch(error => this.failSessionScreenState(current, error));
  }

  failSessionScreenState(session, error) {
    const current = this.sessions.get(session.id);
    if (!current || current.stateProofAvailable === false) return;
    current.stateProofAvailable = false;
    const message = error instanceof Error ? error.message : String(error || 'unknown reducer failure');
    this.emit('session-error', {
      sessionId: current.id,
      error: `Terminal state reducer failed: ${message}`,
      fatal: true
    });
    try {
      current.process?.kill();
    } catch {
      // The runtime cannot continue safely without its authoritative reducer.
    }
  }

  trackSessionRendererData(session, data) {
    const expired = expireTerminalGeometryIfNeeded(session);
    const hasOwner = Boolean(
      session.geometryControl?.ownerKey &&
      session.geometryControl?.leaseId &&
      session.geometryControl.expiresAt > Date.now()
    );
    if (expired || !hasOwner) {
      const control = ensureTerminalReducerFlowControl(session);
      const resetError = resetTerminalRendererFlowControl(control, session.process);
      return resetError || setTerminalExternalFlowControlBlocked(control, session.process, false);
    }
    if (session.geometryControl.rendererReadyFence !== session.geometryControl.fence) {
      return null;
    }
    return enqueueTerminalRendererData(
      ensureTerminalReducerFlowControl(session),
      session.process,
      String(data || '').length,
    );
  }

  async sendInput(sessionId, input, options = {}) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.process) {
      throw new Error('Session not available');
    }

    if (options.terminalControl) {
      const controlState = validateTerminalGeometryInput(session, options.terminalControl);
      if (controlState.status !== 'input-accepted') return controlState;
    }
    session.process.write(terminalInputToPtyString(input));
    session.lastActivityAt = Date.now();
    this.emit('session-activity', {
      sessionId,
      lastActivityAt: session.lastActivityAt
    });
    return { sent: true };
  }

  async interruptSession(sessionId, input = '\x03') {
    return this.sendInput(sessionId, input);
  }

  async claimSessionGeometry(sessionId, geometry) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status === 'exited') {
      return { status: 'rejected', reason: 'session-unavailable' };
    }
    const previousLeaseId = session.geometryControl?.leaseId || '';
    const result = claimTerminalGeometry(session, geometry);
    if (result.status === 'owner' && result.leaseId !== previousLeaseId) {
      const flowError = setTerminalExternalFlowControlBlocked(
        ensureTerminalReducerFlowControl(session),
        session.process,
        true,
      );
      if (flowError) this.failSessionScreenState(session, flowError);
    }
    return result;
  }

  async activateSessionRenderer(sessionId, geometry) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status === 'exited') {
      return { status: 'renderer-ready-rejected', reason: 'session-unavailable' };
    }
    const controlState = validateTerminalGeometryRendererReady(session, geometry);
    if (controlState.status !== 'renderer-ready-accepted') return controlState;
    if (session.geometryControl.rendererReadyFence === geometry.fence) {
      return { ...controlState, status: 'renderer-ready-accepted', duplicate: true };
    }
    const flowControl = ensureTerminalReducerFlowControl(session);
    const resetError = resetTerminalRendererFlowControl(flowControl, session.process);
    if (resetError) {
      this.failSessionScreenState(session, resetError);
      return { ...controlState, status: 'renderer-ready-rejected', reason: 'flow-control-failed' };
    }
    session.geometryControl.rendererReadyFence = geometry.fence;
    const resumeError = setTerminalExternalFlowControlBlocked(flowControl, session.process, false);
    if (resumeError) {
      session.geometryControl.rendererReadyFence = 0;
      this.failSessionScreenState(session, resumeError);
      return { ...controlState, status: 'renderer-ready-rejected', reason: 'flow-control-failed' };
    }
    return { ...controlState, status: 'renderer-ready-accepted' };
  }

  async getSessionAttachCheckpoint(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status === 'exited') return null;
    return captureTerminalAttachCheckpoint(session);
  }

  async renewSessionGeometry(sessionId, geometry) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status === 'exited') {
      return { status: 'rejected', reason: 'session-unavailable' };
    }
    return renewTerminalGeometry(session, geometry);
  }

  async releaseSessionGeometry(sessionId, geometry) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status === 'exited') {
      return { status: 'unowned', reason: 'session-unavailable' };
    }
    const result = releaseTerminalGeometry(session, geometry);
    if (result.status === 'unowned') {
      const flowControl = ensureTerminalReducerFlowControl(session);
      const flowError = resetTerminalRendererFlowControl(flowControl, session.process)
        || setTerminalExternalFlowControlBlocked(flowControl, session.process, false);
      if (flowError) this.failSessionScreenState(session, flowError);
    }
    return result;
  }

  async acknowledgeSessionOutput(sessionId, charCount, geometry) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status === 'exited') {
      return { status: 'output-ack-rejected', reason: 'session-unavailable' };
    }
    const controlState = validateTerminalGeometryOutputAck(session, geometry);
    if (controlState.status !== 'output-ack-accepted') return controlState;
    const flowError = acknowledgeTerminalRendererData(
      ensureTerminalReducerFlowControl(session),
      session.process,
      charCount,
    );
    if (flowError) {
      this.failSessionScreenState(session, flowError);
      return {
        ...controlState,
        status: 'output-ack-rejected',
        reason: 'flow-control-failed',
      };
    }
    return {
      ...controlState,
      acknowledged: Math.max(0, Math.floor(Number(charCount) || 0)),
    };
  }

  async resizeSession(sessionId, cols, rows, geometry) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.process || !session.process.resize) {
      return { status: 'resize-rejected', reason: 'session-unavailable', resized: false };
    }
    if (session.status === 'exited') {
      return { status: 'resize-rejected', reason: 'session-unavailable', resized: false };
    }

    const resize = beginTerminalGeometryResize(session, geometry);
    if (!resize.accepted) {
      return {
        ...resize.result,
        resized: resize.duplicate === true || resize.result?.status === 'resize-committed',
      };
    }
    if (cols === session.previewCols && rows === session.previewRows) {
      return commitTerminalGeometryResize(session, resize.requestSeq, {
        resized: true,
        unchanged: true,
      }, resize.token);
    }

    try {
      session.process.resize(cols, rows);
    } catch (error) {
      if (error && String(error.message || '').includes('EBADF')) {
        session.status = 'exited';
        session.exitedAt = session.exitedAt || Date.now();
        return rejectTerminalGeometryResize(
          session,
          resize.requestSeq,
          'session-unavailable',
          {},
          resize.token,
        );
      }
      return rejectTerminalGeometryResize(session, resize.requestSeq, 'pty-resize-failed', {
        error: error instanceof Error ? error.message : String(error || 'unknown PTY resize failure'),
      }, resize.token);
    }
    session.stateRevision += 1;
    const stateRevision = session.stateRevision;
    const outputSeq = session.outputSeq;
    const runtimeEpoch = session.runtimeEpoch;
    session.previewCols = cols || session.previewCols;
    session.previewRows = rows || session.previewRows;
    if (!session.screenWorker) {
      return commitTerminalGeometryResize(session, resize.requestSeq, {
        resized: true,
        unchanged: false,
      }, resize.token);
    }

    const reducerCommit = session.screenWorker.resize(cols, rows, stateRevision);
    const publishedCommit = session.reducerCommitQueue.then(() => reducerCommit).then((screenState) => {
      if (
        screenState.runtimeEpoch !== runtimeEpoch ||
        screenState.outputSeq !== outputSeq ||
        screenState.stateRevision !== stateRevision
      ) {
        throw new Error('Terminal screen resize returned a non-authoritative state cut');
      }
      session.previewText = screenState.previewText || '';
      session.previewSnapshot = screenState.previewSnapshot || session.previewSnapshot;
      session.renderOutput = typeof screenState.renderOutput === 'string'
        ? screenState.renderOutput
        : session.renderOutput;
      session.previewCols = screenState.cols || cols || session.previewCols;
      session.previewRows = screenState.rows || rows || session.previewRows;
      if (screenState.title && screenState.title !== session.title) {
        session.title = screenState.title;
        this.emit('session-title', {
          sessionId,
          title: session.title
        });
      }
      this.emit('session-transition', {
        sessionId,
        kind: 'resize',
        data: '',
        runtimeEpoch: screenState.runtimeEpoch,
        outputSeq: screenState.outputSeq,
        stateRevision: screenState.stateRevision,
        cols: screenState.cols,
        rows: screenState.rows
      });
      return screenState;
    });
    session.reducerCommitQueue = publishedCommit.catch(error => {
      this.failSessionScreenState(session, error);
    });
    try {
      await publishedCommit;
    } catch {
      return rejectTerminalGeometryResize(
        session,
        resize.requestSeq,
        'screen-reducer-failed',
        {},
        resize.token,
      );
    }
    return commitTerminalGeometryResize(session, resize.requestSeq, {
      resized: true,
      unchanged: false,
      runtimeEpoch,
      outputSeq,
      stateRevision,
      cols,
      rows,
    }, resize.token);
  }

  async clearBuffer(sessionId, geometry = null) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { cleared: false };
    }
    if (geometry) {
      const controlState = validateTerminalGeometryClear(session, geometry);
      if (controlState.status !== 'clear-accepted') {
        return { cleared: false, ...controlState };
      }
    }

    session.output = '';
    session.stateRevision += 1;
    const stateRevision = session.stateRevision;
    const outputSeq = session.outputSeq;
    const runtimeEpoch = session.runtimeEpoch;
    session.renderOutput = '';
    session.previewText = '';
    session.previewSnapshot = null;
    session.lastActivityAt = Date.now();

    let exactState = {
      renderOutput: '',
      runtimeEpoch,
      outputSeq,
      stateRevision,
      cols: session.previewCols,
      rows: session.previewRows,
    };
    if (session.screenWorker) {
      const reducerCommit = session.screenWorker.clear(stateRevision, outputSeq);
      const publishedCommit = session.reducerCommitQueue.then(() => reducerCommit).then((screenState) => {
        if (
          screenState.runtimeEpoch !== runtimeEpoch ||
          screenState.outputSeq !== outputSeq ||
          screenState.stateRevision !== stateRevision
        ) {
          throw new Error('Terminal screen clear returned a non-authoritative state cut');
        }
        session.renderOutput = typeof screenState.renderOutput === 'string' ? screenState.renderOutput : '';
        session.previewText = screenState.previewText || '';
        session.previewSnapshot = screenState.previewSnapshot || null;
        session.previewCols = screenState.cols || session.previewCols;
        session.previewRows = screenState.rows || session.previewRows;
        exactState = screenState;
        if (screenState.title && screenState.title !== session.title) {
          session.title = screenState.title;
          this.emit('session-title', { sessionId, title: session.title });
        }
        this.emit('session-transition', {
          sessionId,
          kind: 'clear',
          data: '\x1b[2J\x1b[3J\x1b[H',
          runtimeEpoch: screenState.runtimeEpoch,
          outputSeq: screenState.outputSeq,
          stateRevision: screenState.stateRevision,
          cols: screenState.cols,
          rows: screenState.rows
        });
        return screenState;
      });
      session.reducerCommitQueue = publishedCommit.catch(error => {
        this.failSessionScreenState(session, error);
      });
      try {
        await publishedCommit;
      } catch {
        return { cleared: false };
      }
    }
    this.emit('session-preview', {
      sessionId,
      previewText: session.previewText,
      cols: session.previewCols,
      rows: session.previewRows,
      previewSnapshot: session.previewSnapshot,
      title: session.title
    });
    this.emit('session-activity', {
      sessionId,
      lastActivityAt: session.lastActivityAt
    });
    return {
      cleared: true,
      runtimeEpoch: exactState.runtimeEpoch,
      outputSeq: exactState.outputSeq,
      stateRevision: exactState.stateRevision,
      cols: exactState.cols,
      rows: exactState.rows,
      expiresAt: session.geometryControl?.expiresAt || 0,
    };
  }

  async killSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.process) {
      return;
    }

    session.status = 'stopping';
    session.killRequestedAt = Date.now();
    session.process.kill('SIGTERM');

    const killTimer = setTimeout(() => {
      const latest = this.sessions.get(sessionId);
      if (!latest || latest.status === 'exited' || !latest.process) {
        return;
      }
      latest.process.kill('SIGKILL');
    }, 1500);
    if (typeof killTimer.unref === 'function') killTimer.unref();
  }

  async getSessionState(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const snapshotOutput = session.output;
    const fallbackPreviewText = session.previewText;
    const fallbackPreviewSnapshot = session.previewSnapshot;
    const fallbackPreviewCols = session.previewCols;
    const fallbackPreviewRows = session.previewRows;
    const fallbackTitle = session.title;
    const checkpoint = await captureTerminalAttachCheckpoint(session);
    const title = checkpoint ? checkpoint.title : fallbackTitle;
    const previewText = checkpoint ? checkpoint.previewText : fallbackPreviewText;

    return {
      sessionId: session.id,
      status: session.status,
      runtimeEpoch: session.runtimeEpoch,
      output: snapshotOutput,
      outputSeq: checkpoint?.outputSeq ?? null,
      stateRevision: checkpoint?.stateRevision ?? null,
      renderOutput: checkpoint ? checkpoint.renderOutput : snapshotOutput,
      previewText,
      previewSnapshot: checkpoint ? checkpoint.previewSnapshot : fallbackPreviewSnapshot,
      previewCols: checkpoint ? checkpoint.cols : fallbackPreviewCols,
      previewRows: checkpoint ? checkpoint.rows : fallbackPreviewRows,
      title,
      lastActivityAt: session.lastActivityAt,
      startedAt: session.startedAt,
      exitedAt: session.exitedAt || null,
      terminalBusy: session.terminalBusy,
      shellCommand: session.shellCommand || '',
      shellLastCommand: session.shellLastCommand || '',
      shellCommandStartedAt: session.shellCommandStartedAt ?? null,
      shellLastCommandStartedAt: session.shellLastCommandStartedAt ?? null,
      shellLastCommandFinishedAt: session.shellLastCommandFinishedAt ?? null,
      shellLastCommandDurationMs: session.shellLastCommandDurationMs ?? null,
      terminalStatus: deriveTerminalStatus({
        command: session.command,
        cwd: session.shellCwd || session.cwd,
        status: session.status,
        title,
        previewText,
        terminalBusy: session.terminalBusy,
        shellLastExitCode: session.shellLastExitCode,
        shellLastEvent: session.shellLastEvent,
        shellCommand: session.shellCommand,
        shellLastCommand: session.shellLastCommand,
        shellCommandStartedAt: session.shellCommandStartedAt,
        shellLastCommandStartedAt: session.shellLastCommandStartedAt,
        shellLastCommandFinishedAt: session.shellLastCommandFinishedAt,
        shellLastCommandDurationMs: session.shellLastCommandDurationMs,
      })
    };
  }

  async getSessionPreview(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return '';
    }
    const screenState = session.screenWorker
      ? await session.screenWorker.getState({ includeRenderOutput: false }).catch(() => null)
      : null;
    return (screenState && screenState.previewText) || session.previewText;
  }

  dispose() {
    const disposals = [];
    this.sessions.forEach((session) => {
      try {
        if (session.screenWorker) {
          disposals.push(session.screenWorker.dispose());
        }
        cleanupShellBusyIntegration(session.shellBusyIntegration);
      } catch {
        // best effort
      }
    });
    this.sessions.clear();
    disposals.push(this.screenWorkerPool.dispose());
    return Promise.allSettled(disposals);
  }
}

module.exports = LocalSessionEngine;
module.exports.normalizeShellSessionOptions = normalizeShellSessionOptions;
module.exports.extractLatestTerminalTitle = extractLatestTerminalTitle;
module.exports.createPtyProcess = createPtyProcess;
