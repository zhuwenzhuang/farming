import { useEffect, useRef, useCallback } from 'react'
import { createTerminalInstance } from '@/lib/terminal-engine'
import type { FarmingFitAddon, FarmingTerminal } from '@/lib/terminal-engine'

interface UseTerminalOptions {
  onInput: (data: string) => void
  onResize: (cols: number, rows: number) => void
  /** Called once the terminal is mounted, fitted, and ready to receive writes */
  onReady?: () => void
}

interface UseTerminalResult {
  write: (data: string) => void
  focus: () => void
  isReady: boolean
}

export function useTerminal(
  containerRef: React.RefObject<HTMLDivElement | null>,
  active: boolean,
  options: UseTerminalOptions,
): UseTerminalResult {
  const terminalRef = useRef<FarmingTerminal | null>(null)
  const fitAddonRef = useRef<FarmingFitAddon | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const readyRef = useRef(false)
  const onInputRef = useRef(options.onInput)
  const onResizeRef = useRef(options.onResize)
  const onReadyRef = useRef(options.onReady)

  onInputRef.current = options.onInput
  onResizeRef.current = options.onResize
  onReadyRef.current = options.onReady

  useEffect(() => {
    if (!active || !containerRef.current) return

    let disposed = false
    const container = containerRef.current

    // Clear any previous content
    container.innerHTML = ''

    createTerminalInstance().then(result => {
      if (disposed || !result) return

      const { terminal, fitAddon } = result
      terminalRef.current = terminal
      fitAddonRef.current = fitAddon

      terminal.loadAddon(fitAddon)

      // Hook terminal.onData — the terminal processes keyboard events internally
      // and emits data events (matching old frontend behavior)
      terminal.onData((data: string) => {
        if (disposed) return
        onInputRef.current(data)
      })

      terminal.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        if (disposed) return
        onResizeRef.current(cols, rows)
      })

      terminal.open(container)

      // Fit after the terminal has been rendered (matching old frontend's requestAnimationFrame approach)
      requestAnimationFrame(() => {
        if (disposed) return

        try {
          fitAddon.fit()
        } catch {
          // fit may fail if container has no size yet
        }

        readyRef.current = true

        // Focus the terminal so it can receive keyboard input
        terminal.focus()

        // Notify that terminal is ready for writes
        onReadyRef.current?.()
      })

      // ResizeObserver for auto-fit
      const observer = new ResizeObserver(() => {
        if (disposed) return
        try {
          fitAddon.fit()
        } catch {
          // ignore
        }
      })
      observer.observe(container)
      observerRef.current = observer

      // Click on container refocuses terminal
      container.addEventListener('click', () => {
        if (!disposed && terminal) terminal.focus()
      })
    })

    return () => {
      disposed = true
      readyRef.current = false

      if (observerRef.current) {
        observerRef.current.disconnect()
        observerRef.current = null
      }

      if (terminalRef.current) {
        terminalRef.current.dispose()
        terminalRef.current = null
      }
      fitAddonRef.current = null
    }
  }, [active, containerRef])

  const write = useCallback((data: string) => {
    if (terminalRef.current) {
      terminalRef.current.write(data)
    }
  }, [])

  const focus = useCallback(() => {
    if (terminalRef.current) {
      terminalRef.current.focus()
    }
  }, [])

  return {
    write,
    focus,
    isReady: readyRef.current,
  }
}
