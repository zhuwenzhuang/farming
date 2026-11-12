type DataRecord = Record<string, unknown>
const record = (value: unknown): DataRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as DataRecord : {}
const MAX_OUTPUT_CHARS = 1024 * 1024

export interface AcpNativeTerminal {
  id: string
  output: string
  truncated: boolean
  exitCode?: number | null
  signal?: string | null
}

/** Display-only native terminals never acquire client-terminal process controls. */
export function applyAcpNativeTerminal(previous: unknown, metadata: unknown, replaceOutput: boolean): AcpNativeTerminal | null {
  const meta = record(metadata)
  const info = record(meta.terminal_info)
  const output = record(meta.terminal_output ?? meta.terminal_output_delta)
  const exit = record(meta.terminal_exit)
  const old = record(previous)
  const id = old.id || info.terminal_id || output.terminal_id || exit.terminal_id
  if (typeof id !== 'string' || !id || id.length > 512) return null
  for (const event of [info, output, exit]) {
    if (event.terminal_id != null && event.terminal_id !== id) throw new Error('Native terminal identity changed within a tool call')
  }
  const replaces = replaceOutput && meta.terminal_output != null && typeof output.data === 'string'
  const before = typeof old.output === 'string' ? old.output : ''
  const text = typeof output.data === 'string' ? (replaces ? output.data : before + output.data) : before
  return {
    id, output: text.slice(-MAX_OUTPUT_CHARS),
    truncated: (replaces ? false : old.truncated === true) || text.length > MAX_OUTPUT_CHARS,
    ...(Object.prototype.hasOwnProperty.call(old, 'exitCode') ? { exitCode: old.exitCode as number | null, signal: old.signal as string | null } : {}),
    ...(meta.terminal_exit ? {
      exitCode: Number.isInteger(exit.exit_code) ? Number(exit.exit_code) : null,
      signal: typeof exit.signal === 'string' ? exit.signal : null,
    } : {}),
  }
}

/** A bound terminal owns its output. Preserve independent tool content and result fields. */
export function acpNativeTerminalToolFields(value: unknown, content: unknown, rawOutput: unknown) {
  const terminal = record(value)
  const output = terminal.output
  if (typeof terminal.id !== 'string' || !terminal.id || typeof output !== 'string' || !output) {
    return { content, rawOutput }
  }
  const outputText = output.trim()
  const suffix = terminal.truncated === true && output.length === MAX_OUTPUT_CHARS
    ? output.replace(/\r?\n$/, '') : ''
  // Require the complete retained suffix before omitting a longer snapshot.
  const mirrorsOutput = (candidate: unknown) => typeof candidate === 'string'
    && (candidate === output || !!outputText && candidate.trim() === outputText
      || !!suffix && candidate.replace(/\r?\n$/, '').endsWith(suffix))
  const mirrorsBlock = (candidate: unknown) => {
    const block = record(candidate)
    const text = block.type === 'content' ? record(block.content) : block
    return text.type === 'text' && mirrorsOutput(text.text)
  }
  const stripBlocks = (blocks: unknown) => {
    if (!Array.isArray(blocks)) return blocks
    const kept = blocks.filter(block => !mirrorsBlock(block))
    return kept.length === blocks.length ? blocks : kept
  }
  const stripResult = (source: DataRecord) => {
    const result = { ...source }
    let changed = false
    for (const key of ['content', 'content_items', 'contentItems']) {
      const blocks = source[key]
      const kept = stripBlocks(blocks)
      if (kept === blocks) continue
      if (Array.isArray(kept) && kept.length === 0) delete result[key]
      else result[key] = kept
      changed = true
    }
    return changed ? result : source
  }
  const stripRawOutput = (raw: unknown) => {
    if (mirrorsOutput(raw) || mirrorsBlock(raw)) return undefined
    if (Array.isArray(raw)) {
      const kept = stripBlocks(raw)
      return kept !== raw && Array.isArray(kept) && kept.length === 0 ? undefined : kept
    }
    if (!raw || typeof raw !== 'object') return raw
    const source = record(raw)
    const result = { ...stripResult(source) }
    const { stdout, stderr } = source
    const stdoutMirror = mirrorsOutput(stdout)
    const stderrMirror = mirrorsOutput(stderr)
    const combined = !stdoutMirror && !stderrMirror
      && typeof stdout === 'string' && stdout && typeof stderr === 'string' && stderr
      && mirrorsOutput(`${stdout}\n${stderr}`)
    if (combined || stdoutMirror) delete result.stdout
    if (combined || stderrMirror) delete result.stderr
    const nested = record(source.result)
    const kept = stripResult(nested)
    if (kept !== nested) {
      if (Object.keys(kept).length === 0) delete result.result
      else result.result = kept
    }
    const keys = Object.keys(result)
    if (keys.length === Object.keys(source).length && keys.every(key => result[key] === source[key])) return raw
    return keys.length > 0 ? result : undefined
  }
  return { content: stripBlocks(content), rawOutput: stripRawOutput(rawOutput) }
}

export function acpNativeTerminalDisplay(value: unknown) {
  const terminal = record(value)
  if (typeof terminal.id !== 'string') return null
  const output = typeof terminal.output === 'string' ? terminal.output.trimEnd() : ''
  const exit = Number.isInteger(terminal.exitCode) ? `Exit code: ${terminal.exitCode}`
    : typeof terminal.signal === 'string' && terminal.signal ? `Signal: ${terminal.signal}` : ''
  return [terminal.truncated === true ? '[Earlier terminal output truncated]' : '', output, exit].filter(Boolean).join('\n')
}
