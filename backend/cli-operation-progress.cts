interface OperationStream {
  isTTY?: boolean;
  columns?: number;
  write(chunk: string): unknown;
}

// Lifecycle output shares the dependency renderer's cyan / amber / green / red
// language. Diagnostics go to stderr; command results remain usable on stdout.
function createCliOperationProgress(options: {
  stream?: OperationStream;
  env?: NodeJS.ProcessEnv;
} = {}) {
  const stream = options.stream || process.stderr;
  const env = options.env || process.env;
  const tty = stream.isTTY === true && env.TERM !== 'dumb';
  const color = tty && !('NO_COLOR' in env);
  const paint = (code: number, text: string) => color ? `\u001b[${code}m${text}\u001b[0m` : text;
  const write = (text: string) => {
    try { stream.write(text); } catch { /* A closed terminal must not change lifecycle outcomes. */ }
  };
  const message = (text: string, code = 36) => write(`${paint(code, text)}\n`);

  return {
    message,
    async step<T>(label: string, operation: () => Promise<T>, success: string): Promise<T> {
      const startedAt = Date.now();
      const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
      let frame = 0;
      const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
      const render = () => {
        const text = `${frames[frame++ % frames.length]} ${label} · ${elapsed()}`;
        write(`\r\u001b[2K${paint(36, Array.from(text).slice(0, Math.max(1, (stream.columns || 80) - 1)).join(''))}`);
      };
      if (tty) render();
      else message(`◇ ${label}…`);
      const timer = tty ? setInterval(render, 80) : undefined;
      const clear = () => {
        if (timer) clearInterval(timer);
        if (tty) write('\r\u001b[2K');
      };
      try {
        const result = await operation();
        clear();
        message(`✓ ${success} · ${elapsed()}`, 32);
        return result;
      } catch (error) {
        clear();
        message(`✗ ${label} failed · ${elapsed()}`, 31);
        throw error;
      }
    },
  };
}

export { createCliOperationProgress };
