export interface SessionDataPayload {
  session?: {
    runtimeEpoch?: string
    output?: string
    outputSeq?: number | null
    stateRevision?: number | null
    renderOutput?: string
    previewCols?: number | null
    previewRows?: number | null
    cols?: number | null
    rows?: number | null
  } | string
  output?: string
  runtimeEpoch?: string
  outputSeq?: number | null
  stateRevision?: number | null
  renderOutput?: string
  previewCols?: number | null
  previewRows?: number | null
  cols?: number | null
  rows?: number | null
}

export interface SessionBootstrapState {
  runtimeEpoch: string
  output: string
  outputSeq: number | null
  stateRevision: number | null
  cols: number | null
  rows: number | null
}

function parseSessionOutput(data: SessionDataPayload) {
  if (data.session && typeof data.session === 'object') {
    return data.session.renderOutput ?? data.session.output ?? ''
  }
  if (typeof data.session === 'string') {
    return data.session
  }
  if (typeof data.renderOutput === 'string') {
    return data.renderOutput
  }
  return data.output ?? ''
}

function parseSessionOutputSeq(data: SessionDataPayload) {
  const raw = data.session && typeof data.session === 'object'
    ? data.session.outputSeq
    : data.outputSeq
  const seq = Number(raw)
  return Number.isFinite(seq) && seq >= 0 ? seq : null
}

function parseSessionRuntimeEpoch(data: SessionDataPayload) {
  const raw = data.session && typeof data.session === 'object'
    ? data.session.runtimeEpoch
    : data.runtimeEpoch
  return typeof raw === 'string' ? raw : ''
}

function parseSessionStateRevision(data: SessionDataPayload) {
  const raw = data.session && typeof data.session === 'object'
    ? data.session.stateRevision
    : data.stateRevision
  const revision = Number(raw)
  return Number.isFinite(revision) && revision >= 0 ? revision : null
}

function positiveInteger(value: unknown) {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n > 0 ? n : null
}

function parseSessionDimensions(data: SessionDataPayload) {
  const session = data.session && typeof data.session === 'object' ? data.session : null
  return {
    cols: positiveInteger(session?.previewCols ?? session?.cols ?? data.previewCols ?? data.cols),
    rows: positiveInteger(session?.previewRows ?? session?.rows ?? data.previewRows ?? data.rows),
  }
}

export function sessionBootstrapStateFromPayload(data: SessionDataPayload): SessionBootstrapState {
  const rawOutput = parseSessionOutput(data)
  const dimensions = parseSessionDimensions(data)
  return {
    runtimeEpoch: parseSessionRuntimeEpoch(data),
    // A checkpoint is opaque serialized xterm state. Trimming rows, rebuilding
    // it from text, or moving the cursor would invalidate its revision proof.
    output: rawOutput,
    outputSeq: parseSessionOutputSeq(data),
    stateRevision: parseSessionStateRevision(data),
    cols: dimensions.cols,
    rows: dimensions.rows,
  }
}
