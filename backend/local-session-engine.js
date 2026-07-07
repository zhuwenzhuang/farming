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

const CONTROLLED_BASH_PROMPT = [
  '\\[\\e[90m\\][',
  '\\[\\e[32m\\]\\u@\\h',
  '\\[\\e[90m\\] ',
  '\\[\\e[34m\\]\\w',
  '\\[\\e[90m\\]]',
  '\\[\\e[90m\\] \\$ ',
  '\\[\\e[0m\\]',
].join('');

const CONTROLLED_ZSH_PROMPT = [
  '%F{8}[',
  '%F{2}%n@%m',
  '%F{8} ',
  '%F{4}%~',
  '%F{8}]',
  '%F{8} %# ',
  '%f',
].join('');

const CONTROLLED_ANON_BASH_PROMPT = '\\[\\e[90m\\]\\$ \\[\\e[0m\\]';
const CONTROLLED_ANON_ZSH_PROMPT = '%F{8}%# %f';

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
  const useControlledPrompt = normalized.env.FARMING_SHELL_CONTROLLED_PROMPT === '1'
    || normalized.env.FARMING_ANONYMIZE_SHELL_PROMPT === '1';
  const useAnonymousPrompt = normalized.env.FARMING_ANONYMIZE_SHELL_PROMPT === '1';

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
  constructor() {
    super();
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
    const screenWorker = await this.screenWorkerPool.acquire({
      cols: previewCols,
      rows: previewRows,
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
      this.emit('session-error', {
        sessionId: session.id,
        error: `Failed to update terminal screen state: ${error.message}`,
        fatal: false
      });
    });

    this.sessions.set(session.id, session);
    this.emit('session-started', {
      sessionId: session.id,
      status: session.status,
      startedAt: session.startedAt
    });

    ptyProcess.onData((data) => {
      const current = this.sessions.get(session.id);
      if (!current) return;

      const busyState = parseShellBusyMarkers(data, current.terminalBusy, current.shellBusyMarkerPending);
      current.shellBusyMarkerPending = busyState.pending;
      if (busyState.markerSeen) {
        const markerAt = Date.now();
        current.terminalBusy = busyState.terminalBusy;
        if (busyState.cwd) {
          current.shellCwd = busyState.cwd;
        }
        if (busyState.exitCodeSeen) {
          current.shellLastExitCode = busyState.lastExitCode;
        }
        if (busyState.shellEvent) {
          current.shellLastEvent = busyState.shellEvent;
        }
        if (busyState.shellEvent === 'start') {
          current.shellCommandStartedAt = markerAt;
        }
        if (busyState.commandTextSeen) {
          current.shellCommand = busyState.shellCommand || '';
        }
        if (busyState.shellEvent === 'finish') {
          const commandStartedAt = current.shellCommandStartedAt;
          if (current.shellCommand) {
            current.shellLastCommand = current.shellCommand;
          }
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

      data = busyState.data;
      if (!data) return;

      current.outputSeq += 1;
      current.output += data;
      current.lastActivityAt = Date.now();

      if (current.output.length > 10000) {
        current.output = current.output.slice(-10000);
      }

      const fallbackTitle = extractLatestTerminalTitle(data);
      if (fallbackTitle && fallbackTitle !== current.title) {
        current.title = fallbackTitle;
        this.emit('session-title', {
          sessionId: current.id,
          title: current.title
        });
      }

      this.emit('session-output', {
        sessionId: current.id,
        data,
        outputSeq: current.outputSeq
      });
      this.emit('session-activity', {
        sessionId: current.id,
        lastActivityAt: current.lastActivityAt
      });

      current.screenWorker.append(data);
    });

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

  async sendInput(sessionId, input) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.process) {
      throw new Error('Session not available');
    }

    session.process.write(terminalInputToPtyString(input));
    session.lastActivityAt = Date.now();
    this.emit('session-activity', {
      sessionId,
      lastActivityAt: session.lastActivityAt
    });
  }

  async interruptSession(sessionId, input = '\x03') {
    return this.sendInput(sessionId, input);
  }

  async resizeSession(sessionId, cols, rows) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.process || !session.process.resize) {
      return { resized: false };
    }
    if (session.status === 'exited') {
      return { resized: false };
    }

    try {
      session.process.resize(cols, rows);
    } catch (error) {
      if (error && String(error.message || '').includes('EBADF')) {
        session.status = 'exited';
        session.exitedAt = session.exitedAt || Date.now();
        return { resized: false };
      }
      throw error;
    }
    session.previewCols = cols || session.previewCols;
    session.previewRows = rows || session.previewRows;
    if (!session.screenWorker) {
      return { resized: true, cols: session.previewCols, rows: session.previewRows };
    }

    try {
      const screenState = await session.screenWorker.resize(cols, rows);
      session.previewText = screenState.previewText || '';
      session.previewSnapshot = screenState.previewSnapshot || session.previewSnapshot;
      session.renderOutput = screenState.renderOutput || session.renderOutput;
      session.previewCols = screenState.cols || cols || session.previewCols;
      session.previewRows = screenState.rows || rows || session.previewRows;
      if (screenState.title && screenState.title !== session.title) {
        session.title = screenState.title;
        this.emit('session-title', {
          sessionId,
          title: session.title
        });
      }
    } catch (error) {
      this.emit('session-error', {
        sessionId,
        error: `Failed to resize terminal screen state: ${error.message}`,
        fatal: false
      });
    }
    return { resized: true, cols: session.previewCols, rows: session.previewRows };
  }

  async clearBuffer(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { cleared: false };
    }

    session.output = '';
    session.outputSeq = (session.outputSeq || 0) + 1;
    session.renderOutput = '';
    session.previewText = '';
    session.previewSnapshot = null;
    session.lastActivityAt = Date.now();

    if (session.screenWorker) {
      try {
        const screenState = await session.screenWorker.clear();
        session.renderOutput = screenState.renderOutput || '';
        session.previewText = screenState.previewText || '';
        session.previewSnapshot = screenState.previewSnapshot || null;
        session.previewCols = screenState.cols || session.previewCols;
        session.previewRows = screenState.rows || session.previewRows;
        if (screenState.title && screenState.title !== session.title) {
          session.title = screenState.title;
          this.emit('session-title', {
            sessionId,
            title: session.title
          });
        }
      } catch (error) {
        this.emit('session-error', {
          sessionId,
          error: `Failed to clear terminal screen state: ${error.message}`,
          fatal: false
        });
      }
    }

    this.emit('session-sync', {
      sessionId,
      output: session.renderOutput || session.output,
      outputSeq: session.outputSeq,
      replaceLive: true
    });
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
    return { cleared: true, outputSeq: session.outputSeq };
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
    const screenState = session.screenWorker
      ? await session.screenWorker.getState().catch(() => null)
      : null;

    const title = (screenState && screenState.title) || session.title;
    const previewText = (screenState && screenState.previewText) || session.previewText;

    return {
      sessionId: session.id,
      status: session.status,
      output: session.output,
      outputSeq: session.outputSeq || 0,
      renderOutput: (screenState && screenState.renderOutput) || session.renderOutput,
      previewText,
      previewSnapshot: (screenState && screenState.previewSnapshot) || session.previewSnapshot,
      previewCols: (screenState && screenState.cols) || session.previewCols,
      previewRows: (screenState && screenState.rows) || session.previewRows,
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
