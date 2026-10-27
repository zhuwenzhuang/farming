export interface SessionDataPayload {
  session?: {
    status?: string
    runtimeEpoch?: string
    output?: string
    outputSeq?: number | null
    stateRevision?: number | null
    renderOutput?: string
    previewText?: string
    renderedScrollback?: number
    scrollbackAvailable?: number
    previewCols?: number | null
    previewRows?: number | null
    cols?: number | null
    rows?: number | null
  } | string
  status?: string
  output?: string
  runtimeEpoch?: string
  outputSeq?: number | null
  stateRevision?: number | null
  renderOutput?: string
  previewText?: string
  renderedScrollback?: number
  scrollbackAvailable?: number
  previewCols?: number | null
  previewRows?: number | null
  cols?: number | null
  rows?: number | null
}

export interface SessionBootstrapState {
  status?: string
  runtimeEpoch: string
  output: string
  outputSeq: number | null
  stateRevision: number | null
  cols: number | null
  rows: number | null
  renderedScrollback?: number
  scrollbackAvailable?: number
}

function parseSessionStatus(data: SessionDataPayload) {
  const raw = data.session && typeof data.session === 'object'
    ? data.session.status
    : data.status
  return typeof raw === 'string' ? raw : ''
}

function parseSessionOutput(data: SessionDataPayload) {
  const hasRetainedCheckpoint = Boolean(parseSessionRuntimeEpoch(data))
    && parseSessionOutputSeq(data) !== null
    && parseSessionStateRevision(data) !== null
  if (data.session && typeof data.session === 'object') {
    const primary = data.session.renderOutput ?? data.session.output ?? ''
    if (primary || hasRetainedCheckpoint) return primary
    return data.session.previewText ?? ''
  }
  if (typeof data.session === 'string') {
    return data.session
  }
  if (typeof data.renderOutput === 'string') {
    if (data.renderOutput || hasRetainedCheckpoint) return data.renderOutput
  }
  const fallback = data.output ?? ''
  if (fallback || hasRetainedCheckpoint) return fallback
  return data.previewText ?? ''
}

function nonNegativeSequence(raw: unknown) {
  if (raw === null || raw === undefined || raw === '' || typeof raw === 'boolean') return null
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : null
}

function parseSessionOutputSeq(data: SessionDataPayload) {
  const raw = data.session && typeof data.session === 'object'
    ? data.session.outputSeq
    : data.outputSeq
  return nonNegativeSequence(raw)
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
  return nonNegativeSequence(raw)
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
  const status = parseSessionStatus(data)
  const rawOutput = parseSessionOutput(data)
  const dimensions = parseSessionDimensions(data)
  const session = data.session && typeof data.session === 'object' ? data.session : null
  return {
    ...(status ? { status } : {}),
    runtimeEpoch: parseSessionRuntimeEpoch(data),
    // A checkpoint is opaque serialized xterm state. Trimming rows, rebuilding
    // it from text, or moving the cursor would invalidate its revision proof.
    output: rawOutput,
    outputSeq: parseSessionOutputSeq(data),
    stateRevision: parseSessionStateRevision(data),
    cols: dimensions.cols,
    rows: dimensions.rows,
    renderedScrollback: Math.max(0, Math.floor(Number(session?.renderedScrollback ?? data.renderedScrollback) || 0)),
    scrollbackAvailable: Math.max(0, Math.floor(Number(session?.scrollbackAvailable ?? data.scrollbackAvailable) || 0)),
  }
}
