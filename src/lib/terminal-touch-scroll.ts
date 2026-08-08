const TOUCH_MOMENTUM_MIN_VELOCITY = 0.025
const TOUCH_MOMENTUM_MAX_VELOCITY = 3.2
const TOUCH_MOMENTUM_DECAY_PER_FRAME = 0.972
const TOUCH_VELOCITY_WINDOW_MS = 90
const TOUCH_EDGE_RESISTANCE = 0.28
const TOUCH_EDGE_MAX_OFFSET_PX = 30

export interface TerminalTouchVelocitySample {
  y: number
  at: number
}

export interface TerminalTouchScrollDelta {
  lineDelta: number
  remainderPx: number
}

export interface TerminalTouchMomentumStep {
  elapsedMs: number
  scrollDeltaPx: number
  nextVelocity: number
  shouldContinue: boolean
}

export function clampTerminalTouchVelocity(velocity: number): number {
  return Math.max(
    -TOUCH_MOMENTUM_MAX_VELOCITY,
    Math.min(TOUCH_MOMENTUM_MAX_VELOCITY, velocity),
  )
}

export function appendTerminalTouchVelocitySample(
  samples: readonly TerminalTouchVelocitySample[],
  sample: TerminalTouchVelocitySample,
): TerminalTouchVelocitySample[] {
  const nextSamples = [...samples, sample]
  const cutoff = sample.at - TOUCH_VELOCITY_WINDOW_MS
  while (nextSamples.length > 2 && nextSamples[0]!.at < cutoff) {
    nextSamples.shift()
  }
  return nextSamples
}

export function readTerminalTouchGestureVelocity(
  samples: readonly TerminalTouchVelocitySample[],
  fallbackVelocity: number,
): number {
  const first = samples[0]
  const last = samples[samples.length - 1]
  if (!first || !last || last.at <= first.at) return fallbackVelocity
  return clampTerminalTouchVelocity((last.y - first.y) / (last.at - first.at))
}

export function blendTerminalTouchVelocity(
  gestureVelocity: number,
  deltaY: number,
  elapsedMs: number,
): number {
  const instantVelocity = deltaY / elapsedMs
  return clampTerminalTouchVelocity(gestureVelocity * 0.72 + instantVelocity * 0.28)
}

export function consumeTerminalTouchScrollDelta(
  remainderPx: number,
  deltaY: number,
  lineHeightPx: number,
): TerminalTouchScrollDelta {
  const nextRemainderPx = remainderPx + deltaY
  const lineDelta = Math.trunc(nextRemainderPx / lineHeightPx)
  return {
    lineDelta,
    remainderPx: nextRemainderPx - lineDelta * lineHeightPx,
  }
}

export function nextTerminalTouchEdgeOffset(currentOffsetPx: number, deltaY: number): number {
  return Math.max(
    -TOUCH_EDGE_MAX_OFFSET_PX,
    Math.min(TOUCH_EDGE_MAX_OFFSET_PX, currentOffsetPx + deltaY * TOUCH_EDGE_RESISTANCE),
  )
}

export function shouldStartTerminalTouchMomentum(velocity: number): boolean {
  return Math.abs(velocity) >= TOUCH_MOMENTUM_MIN_VELOCITY
}

export function stepTerminalTouchMomentum(
  velocity: number,
  lastTimestamp: number,
  timestamp: number,
): TerminalTouchMomentumStep {
  const elapsedMs = lastTimestamp === 0
    ? 16
    : Math.min(48, Math.max(1, timestamp - lastTimestamp))
  const nextVelocity = velocity * Math.pow(TOUCH_MOMENTUM_DECAY_PER_FRAME, elapsedMs / 16)
  return {
    elapsedMs,
    scrollDeltaPx: velocity * elapsedMs,
    nextVelocity,
    shouldContinue: Math.abs(nextVelocity) >= TOUCH_MOMENTUM_MIN_VELOCITY,
  }
}
