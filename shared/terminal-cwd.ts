// Cwd belongs to the ordered terminal stream. Markers follow reflow and trim;
// checkpoints carry the surviving ranges, never infer cwd from prompt text.
interface Marker { line: number; isDisposed: boolean; dispose(): void }
interface CwdTerminal {
  buffer: { active: { type: string; baseY: number; cursorY: number }; normal: { baseY: number; cursorY: number } }
  parser: { registerOscHandler(id: number, handler: (data: string) => boolean): { dispose(): void } }
  registerMarker(offset?: number): Marker | undefined
}
const SNAPSHOT_PREFIX = 'FarmingCwdSnapshot='
const MAX_RANGES = 128
export class TerminalCwdHistory {
  private entries: Array<{ marker: Marker; cwd: string }> = []
  private baseline: string | undefined
  private readonly subscriptions: Array<{ dispose(): void }>
  private readonly terminal: CwdTerminal
  constructor(terminal: CwdTerminal) {
    this.terminal = terminal
    this.subscriptions = [
      terminal.parser.registerOscHandler(7, data => {
        try {
          const url = new URL(data)
          const cwd = decodeURIComponent(url.pathname)
          if (url.protocol === 'file:' && cwd.startsWith('/') && cwd.length <= 2048) this.record(cwd)
        } catch { /* Invalid cwd markers do not establish path identity. */ }
        return false
      }),
      terminal.parser.registerOscHandler(133, data => {
        if (!data.startsWith(SNAPSHOT_PREFIX)) return false
        this.clear()
        try {
          const values: unknown = JSON.parse(decodeURIComponent(data.slice(SNAPSHOT_PREFIX.length)))
          if (Array.isArray(values) && values.length <= MAX_RANGES + 1) {
            for (const value of values) {
              if (!Array.isArray(value) || value.length !== 2) continue
              const [line, cwd] = value
              if (!Number.isInteger(line) || line < 0 || typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.length > 2048) continue
              this.record(cwd, line)
            }
          }
        } catch { /* Old or invalid checkpoints leave cwd unknown. */ }
        return true
      }),
    ]
  }
  private prune() {
    while (this.entries[0]?.marker.isDisposed) this.baseline = this.entries.shift()!.cwd
  }
  private record(cwd: string, line?: number) {
    if (this.terminal.buffer.active.type !== 'normal') return
    this.prune()
    const buffer = this.terminal.buffer.normal
    const row = line ?? buffer.baseY + buffer.cursorY
    const last = this.entries[this.entries.length - 1]
    if (last?.cwd === cwd) return
    if (last?.marker.line === row) this.entries.pop()!.marker.dispose()
    const marker = this.terminal.registerMarker(row - buffer.baseY - buffer.cursorY)
    if (marker) this.entries.push({ marker, cwd })
    // Forget old ranges rather than assign a newer cwd to old output.
    if (this.entries.length > MAX_RANGES) {
      this.entries.shift()!.marker.dispose()
      this.baseline = undefined
    }
  }
  atLine(line: number): string | undefined {
    if (this.terminal.buffer.active.type !== 'normal') return undefined
    return this.normalCwdAtLine(line)
  }
  private normalCwdAtLine(line: number): string | undefined {
    this.prune()
    for (let index = this.entries.length - 1; index >= 0; index--) {
      const entry = this.entries[index]!
      if (!entry.marker.isDisposed && entry.marker.line <= line) return entry.cwd
    }
    return this.baseline
  }
  serialize(scrollback: number): string {
    this.prune()
    const start = Math.max(0, this.terminal.buffer.normal.baseY - scrollback)
    const values: Array<[number, string]> = []
    const baseline = this.normalCwdAtLine(start)
    if (baseline) values.push([0, baseline])
    for (const entry of this.entries) {
      if (!entry.marker.isDisposed && entry.marker.line > start) values.push([entry.marker.line - start, entry.cwd])
    }
    return `\x1b]133;${SNAPSHOT_PREFIX}${encodeURIComponent(JSON.stringify(values))}\x07`
  }
  checkpoint(output: string, scrollback: number): string {
    const snapshot = this.serialize(scrollback)
    // SerializeAddon restores the normal buffer before entering the alternate
    // buffer. Install normal-buffer markers while that buffer is still active.
    const alternate = output.indexOf('\x1b[?1049h')
    return alternate < 0 ? output + snapshot : output.slice(0, alternate) + snapshot + output.slice(alternate)
  }
  clear() { this.entries.forEach(entry => entry.marker.dispose()); this.entries = []; this.baseline = undefined }
  dispose() { this.clear(); this.subscriptions.forEach(item => item.dispose()) }
}

export function terminalCwdSequence(cwd: string): string {
  return `\x1b]7;file://${encodeURI(cwd).replace(/#/g, '%23').replace(/\?/g, '%3F')}\x07`
}
