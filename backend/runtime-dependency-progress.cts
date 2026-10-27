import type { RuntimeDependencyProgress } from './runtime-dependency-manager.cjs';

interface ProgressStream {
  isTTY?: boolean;
  columns?: number;
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
  const rows = new Map<string, { text: string; color: number }>();
  let active = false;
  let renderedRows = 0;
  let lastRenderAt = 0;

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
  const writeLine = (text: string): void => {
    write(`${text}\n`);
  };
  const begin = (): void => {
    if (active) return;
    active = true;
    writeLine(paint(36, 'Preparing startup dependencies'));
  };
  const renderRows = (force = false): void => {
    if (!tty || rows.size === 0) return;
    const timestamp = now();
    if (!force && timestamp - lastRenderAt < TTY_RENDER_INTERVAL_MS) return;
    lastRenderAt = timestamp;
    // Leave the cursor below the block. Keep each row shorter than the terminal
    // width so wrapping cannot turn a dependency into multiple physical rows.
    const width = Math.max(1, (stream.columns || 80) - 1);
    let output = renderedRows ? `\u001b[${renderedRows}A` : '';
    for (const row of rows.values()) {
      const text = row.text.length > width ? `${row.text.slice(0, width - 1)}…` : row.text;
      output += `\r\u001b[2K${paint(row.color, text)}\n`;
    }
    write(output);
    renderedRows = rows.size;
  };
  const updateRow = (id: string, text: string, color: number, force = true): void => {
    const previous = rows.get(id);
    if (previous?.text === text && previous.color === color) return;
    rows.set(id, { text, color });
    renderRows(force || !previous);
  };
  const status = (id: string, text: string, color: number): void => {
    begin();
    if (tty) updateRow(id, text, color);
    else writeLine(text);
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

    updateRow(
      progress.dependencyId,
      progressLine(label, receivedBytes, totalBytes),
      36,
      receivedBytes === 0 || (totalBytes > 0 && receivedBytes >= totalBytes),
    );
  };

  return {
    abort(): void {
      renderRows(true);
      renderedRows = 0;
      rows.clear();
      active = false;
    },
    finish(): void {
      if (!active) return;
      renderRows(true);
      writeLine(paint(32, '✓ Startup dependencies ready'));
      renderedRows = 0;
      rows.clear();
      active = false;
    },
    report(progress: RuntimeDependencyProgress): void {
      const label = LABELS[progress.dependencyId] || progress.dependencyId;
      if (progress.phase === 'download') {
        renderDownload(progress, label);
        return;
      }
      if (progress.phase === 'failed') {
        status(progress.dependencyId, `✗ ${label} ${progress.version} failed`, 31);
        return;
      }
      if (!downloaded.has(progress.dependencyId)) return;
      if (progress.phase === 'retry') {
        logBuckets.delete(progress.dependencyId);
        status(progress.dependencyId, `! ${label}: mirror unavailable, retrying npm registry`, 33);
        return;
      }
      if (progress.phase === 'verify') {
        status(progress.dependencyId, `◇ ${label}: downloaded, verifying`, 33);
        return;
      }
      if (progress.phase === 'ready') {
        status(progress.dependencyId, `✓ ${label} ${progress.version} ready`, 32);
      }
    },
  };
}

export {
  createRuntimeDependencyProgressRenderer,
  formatBytes,
  progressLine,
};
