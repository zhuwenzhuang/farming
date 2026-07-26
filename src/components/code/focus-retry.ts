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
