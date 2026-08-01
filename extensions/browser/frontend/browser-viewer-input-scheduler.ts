export interface BrowserViewerInputMessage {
  type: string
  [key: string]: unknown
}

interface PendingInput {
  message: BrowserViewerInputMessage
  order: number
}

export class BrowserViewerInputScheduler {
  private frame: number | null = null
  private nextOrder = 0
  private pendingMove: PendingInput | null = null
  private pendingWheel: PendingInput | null = null

  constructor(
    private readonly send: (message: BrowserViewerInputMessage) => void,
    private readonly schedule: (callback: () => void) => number,
    private readonly cancel: (frame: number) => void,
  ) {}

  enqueue(message: BrowserViewerInputMessage): void {
    if (message.type === 'pointer' && message.action === 'move') {
      this.pendingMove = { message, order: ++this.nextOrder }
      this.ensureScheduled()
      return
    }
    if (message.type === 'wheel') {
      const previous = this.pendingWheel?.message
      this.pendingWheel = {
        message: {
          ...message,
          deltaX: Number(previous?.deltaX || 0) + Number(message.deltaX || 0),
          deltaY: Number(previous?.deltaY || 0) + Number(message.deltaY || 0),
        },
        order: ++this.nextOrder,
      }
      this.ensureScheduled()
      return
    }
    this.flush()
    this.send(message)
  }

  flush(): void {
    if (this.frame !== null) {
      this.cancel(this.frame)
      this.frame = null
    }
    const pending = [this.pendingMove, this.pendingWheel]
      .filter((input): input is PendingInput => input !== null)
      .sort((left, right) => left.order - right.order)
    this.pendingMove = null
    this.pendingWheel = null
    pending.forEach(input => this.send(input.message))
  }

  clear(): void {
    if (this.frame !== null) this.cancel(this.frame)
    this.frame = null
    this.pendingMove = null
    this.pendingWheel = null
  }

  private ensureScheduled(): void {
    if (this.frame !== null) return
    this.frame = this.schedule(() => {
      this.frame = null
      this.flush()
    })
  }
}
