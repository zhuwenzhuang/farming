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
