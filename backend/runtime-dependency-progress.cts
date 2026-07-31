import type { RuntimeDependencyProgress } from './runtime-dependency-manager.cjs';

interface ProgressStream {
  isTTY?: boolean;
  write(chunk: string): unknown;
}

interface ProgressRendererOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  stream?: ProgressStream;
}

interface RuntimeDependencyProgressRenderer {
  abort(): void;
  finish(): void;
  report(progress: RuntimeDependencyProgress): void;
}

const LABELS: Record<string, string> = {
  agentBrowser: 'agent-browser',
  claude: 'Claude Code',
  codex: 'Codex',
};
const BAR_WIDTH = 18;
const TTY_RENDER_INTERVAL_MS = 80;
const UNKNOWN_TOTAL_LOG_STEP_BYTES = 25 * 1024 * 1024;

function formatBytes(bytes: number): string {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KB', 'MB', 'GB'];
  let scaled = value;
  let unit = 'B';
  for (const candidate of units) {
    scaled /= 1024;
    unit = candidate;
    if (scaled < 1024) break;
  }
  return `${scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(1)} ${unit}`;
}

function progressLine(label: string, receivedBytes: number, totalBytes: number): string {
  if (totalBytes <= 0) return `↓ ${label}  ${formatBytes(receivedBytes)}`;
  const ratio = Math.min(1, Math.max(0, receivedBytes / totalBytes));
  const filled = Math.min(BAR_WIDTH, Math.floor(ratio * BAR_WIDTH));
  const bar = `${'━'.repeat(filled)}${'─'.repeat(BAR_WIDTH - filled)}`;
  const percent = String(Math.floor(ratio * 100)).padStart(3, ' ');
  return `↓ ${label}  ${bar}  ${percent}%  ${formatBytes(receivedBytes)} / ${formatBytes(totalBytes)}`;
}

function createRuntimeDependencyProgressRenderer(
  options: ProgressRendererOptions = {},
): RuntimeDependencyProgressRenderer {
  const stream = options.stream || process.stderr;
  const env = options.env || process.env;
  const now = options.now || Date.now;
  const tty = stream.isTTY === true && env.TERM !== 'dumb';
  const color = tty && !('NO_COLOR' in env);
  const downloaded = new Set<string>();
  const logBuckets = new Map<string, number>();
  let active = false;
  let currentLine = false;
  let lastRenderAt = 0;
  let lastSignature = '';

  const paint = (code: number, text: string): string => (
    color ? `\u001b[${code}m${text}\u001b[0m` : text
  );
  const write = (chunk: string): void => {
    try {
      stream.write(chunk);
    } catch {
      // Rendering is best-effort and must not block startup dependency preparation.
    }
  };
  const clearCurrentLine = (): void => {
    if (!currentLine) return;
    write('\r\u001b[2K');
    currentLine = false;
  };
  const writeLine = (text: string): void => {
    clearCurrentLine();
    write(`${text}\n`);
  };
  const begin = (): void => {
    if (active) return;
    active = true;
    writeLine(paint(36, 'Preparing startup dependencies'));
  };
  const renderDownload = (progress: RuntimeDependencyProgress, label: string): void => {
    begin();
    downloaded.add(progress.dependencyId);
    const receivedBytes = Math.max(0, Number(progress.receivedBytes) || 0);
    const totalBytes = Math.max(0, Number(progress.totalBytes) || 0);
    if (!tty) {
      const bucket = totalBytes > 0
        ? Math.floor(Math.min(1, receivedBytes / totalBytes) * 10)
        : Math.floor(receivedBytes / UNKNOWN_TOTAL_LOG_STEP_BYTES);
      const previous = logBuckets.get(progress.dependencyId);
      if (previous === undefined) {
        logBuckets.set(progress.dependencyId, bucket);
        writeLine(`Downloading ${label} ${progress.version}${totalBytes ? ` (${formatBytes(totalBytes)})` : ''}...`);
      } else if (bucket > previous && (totalBytes <= 0 || bucket < 10)) {
        logBuckets.set(progress.dependencyId, bucket);
        const detail = totalBytes > 0
          ? `${Math.min(99, bucket * 10)}% · ${formatBytes(receivedBytes)} / ${formatBytes(totalBytes)}`
          : formatBytes(receivedBytes);
        writeLine(`Downloading ${label}: ${detail}`);
      }
      return;
    }

    const signature = `${progress.dependencyId}:${receivedBytes}:${totalBytes}`;
    const timestamp = now();
    if (
      receivedBytes > 0
      && receivedBytes < totalBytes
      && timestamp - lastRenderAt < TTY_RENDER_INTERVAL_MS
    ) {
      return;
    }
    if (signature === lastSignature) return;
    lastSignature = signature;
    lastRenderAt = timestamp;
    clearCurrentLine();
    write(`\r\u001b[2K${paint(36, progressLine(label, receivedBytes, totalBytes))}`);
    currentLine = true;
  };

  return {
    abort(): void {
      clearCurrentLine();
    },
    finish(): void {
      if (!active) return;
      writeLine(paint(32, '✓ Startup dependencies ready'));
      active = false;
    },
    report(progress: RuntimeDependencyProgress): void {
      const label = LABELS[progress.dependencyId] || progress.dependencyId;
      if (progress.phase === 'download') {
        renderDownload(progress, label);
        return;
      }
      if (!downloaded.has(progress.dependencyId)) return;
      if (progress.phase === 'retry') {
        logBuckets.delete(progress.dependencyId);
        writeLine(paint(33, `! ${label}: mirror unavailable, retrying npm registry`));
        return;
      }
      if (progress.phase === 'verify') {
        writeLine(paint(33, `◇ ${label}: downloaded, verifying`));
        return;
      }
      if (progress.phase === 'ready') {
        writeLine(paint(32, `✓ ${label} ${progress.version} ready`));
      }
    },
  };
}

export {
  createRuntimeDependencyProgressRenderer,
  formatBytes,
  progressLine,
};
