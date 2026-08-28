export interface FocusRetryScheduler {
  requestAnimationFrame(callback: () => void): number
  cancelAnimationFrame(handle: number): void
  setTimeout(callback: () => void, delay: number): number
  clearTimeout(handle: number): void
}

export interface FocusRetryOptions {
  delays?: number[]
  animationFrame?: boolean
  runNow?: boolean
}

export interface FocusRetryIntentTarget {
  addEventListener(type: 'pointerdown' | 'keydown', listener: EventListener, capture?: boolean): void
  removeEventListener(type: 'pointerdown' | 'keydown', listener: EventListener, capture?: boolean): void
}

function browserFocusRetryScheduler(): FocusRetryScheduler {
  return window
}

export function scheduleFocusRetries(
  focus: () => void,
  options: FocusRetryOptions = {},
  scheduler: FocusRetryScheduler = browserFocusRetryScheduler(),
) {
  const delays = options.delays ?? []
  const timers: number[] = []
  const useAnimationFrame = options.animationFrame !== false
  let frame: number | undefined

  if (options.runNow !== false) focus()
  if (useAnimationFrame) frame = scheduler.requestAnimationFrame(focus)
  delays.forEach(delay => {
    timers.push(scheduler.setTimeout(focus, delay))
  })

  return () => {
    if (frame !== undefined) scheduler.cancelAnimationFrame(frame)
    timers.forEach(timer => scheduler.clearTimeout(timer))
  }
}

export function scheduleUserCancelableFocusRetries(
  focus: () => void,
  options: FocusRetryOptions = {},
  intentTarget: FocusRetryIntentTarget = window,
  scheduler: FocusRetryScheduler = browserFocusRetryScheduler(),
) {
  let cancelRetries = () => {}
  let cleanupTimer: number | undefined
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    cancelRetries()
    intentTarget.removeEventListener('pointerdown', cleanup, true)
    intentTarget.removeEventListener('keydown', cleanup, true)
    if (cleanupTimer !== undefined) scheduler.clearTimeout(cleanupTimer)
  }

  // Return-focus handlers run below the Window capture boundary. Registering
  // there cannot observe the key/pointer event currently being dispatched,
  // but it will cancel restoration for the user's next input immediately.
  intentTarget.addEventListener('pointerdown', cleanup, true)
  intentTarget.addEventListener('keydown', cleanup, true)
  cancelRetries = scheduleFocusRetries(focus, options, scheduler)
  const finalRetryDelay = Math.max(0, ...(options.delays ?? []))
  cleanupTimer = scheduler.setTimeout(cleanup, finalRetryDelay + 40)
  return cleanup
}

export function scheduleFocusUntil(
  focus: () => boolean,
  options: {
    initialDelay?: number
    retryDelay?: number
    maxAttempts: number
    animationFrame?: boolean
  },
  scheduler: FocusRetryScheduler = browserFocusRetryScheduler(),
) {
  let attempts = 0
  let frame: number | undefined
  let timer: number | undefined
  let stopped = false

  const run = () => {
    frame = undefined
    if (stopped || attempts >= Math.max(1, options.maxAttempts)) return
    attempts += 1
    if (focus() || attempts >= options.maxAttempts) return
    timer = scheduler.setTimeout(queue, options.retryDelay ?? 90)
  }
  const queue = () => {
    timer = undefined
    if (stopped) return
    if (options.animationFrame === false) run()
    else frame = scheduler.requestAnimationFrame(run)
  }

  timer = scheduler.setTimeout(queue, options.initialDelay ?? 0)
  return () => {
    stopped = true
    if (frame !== undefined) scheduler.cancelAnimationFrame(frame)
    if (timer !== undefined) scheduler.clearTimeout(timer)
  }
}
