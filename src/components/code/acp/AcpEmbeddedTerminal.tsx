import { useEffect, useRef, useState } from 'react'
import { createXtermTerminalInstance } from '@/lib/xterm'

interface AcpEmbeddedTerminalProps {
  terminalId: string
  output: string
  interactive: boolean
  onInput?: (input: string) => Promise<void>
  onResize?: (cols: number, rows: number) => Promise<void>
}

export function AcpEmbeddedTerminal({
  terminalId,
  output,
  interactive,
  onInput,
  onResize,
}: AcpEmbeddedTerminalProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Awaited<ReturnType<typeof createXtermTerminalInstance>>['terminal'] | null>(null)
  const renderedOutputRef = useRef('')
  const outputRef = useRef(output)
  const interactiveRef = useRef(interactive)
  const inputRef = useRef(onInput)
  const resizeRef = useRef(onResize)
  const lastResizeRef = useRef('')
  const [error, setError] = useState('')
  outputRef.current = output
  interactiveRef.current = interactive
  inputRef.current = onInput
  resizeRef.current = onResize

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    let disposed = false
    let resizeObserver: ResizeObserver | null = null
    let cleanup: (() => void) | undefined
    void createXtermTerminalInstance({ fontSize: 12 }).then(({ terminal, fitAddon }) => {
      if (disposed) {
        terminal.dispose()
        fitAddon.dispose()
        return
      }
      terminal.loadAddon(fitAddon)
      terminal.open(host)
      host.querySelector('textarea')?.setAttribute('aria-label', 'Terminal input')
      terminalRef.current = terminal
      const initialOutput = outputRef.current
      if (initialOutput) terminal.write(initialOutput)
      renderedOutputRef.current = initialOutput
      const dataSubscription = terminal.onData(data => {
        if (!interactiveRef.current || !inputRef.current) return
        void inputRef.current(data).then(() => setError('')).catch(nextError => {
          setError(nextError instanceof Error ? nextError.message : 'Failed to send terminal input')
        })
      })
      const fit = () => {
        if (!host.isConnected || host.clientWidth <= 0 || host.clientHeight <= 0) return
        fitAddon.fit()
        const cols = Number(terminal.cols || 0)
        const rows = Number(terminal.rows || 0)
        const key = `${cols}x${rows}`
        if (!resizeRef.current || cols < 40 || rows < 10 || key === lastResizeRef.current) return
        lastResizeRef.current = key
        void resizeRef.current(cols, rows).catch(() => {})
      }
      resizeObserver = new ResizeObserver(fit)
      resizeObserver.observe(host)
      window.requestAnimationFrame(fit)
      cleanup = () => {
        resizeObserver?.disconnect()
        dataSubscription.dispose()
        fitAddon.dispose()
        terminal.dispose()
      }
    }).catch(nextError => {
      if (!disposed) setError(nextError instanceof Error ? nextError.message : 'Failed to start terminal view')
    })
    return () => {
      disposed = true
      terminalRef.current = null
      cleanup?.()
    }
  }, [terminalId])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal || output === renderedOutputRef.current) return
    if (output.startsWith(renderedOutputRef.current)) {
      terminal.write(output.slice(renderedOutputRef.current.length))
    } else {
      terminal.clearBuffer?.()
      terminal.write(output)
    }
    renderedOutputRef.current = output
  }, [output])

  return (
    <div className={`code-acp-embedded-terminal ${interactive ? 'interactive' : 'readonly'}`} data-testid="code-acp-embedded-terminal">
      <div ref={hostRef} className="code-acp-embedded-terminal-host" onClick={() => terminalRef.current?.focus()} />
      <pre className="code-visually-hidden" aria-label="Terminal output">{output}</pre>
      {error ? <small className="code-codex-transcript-terminal-error" role="alert">{error}</small> : null}
    </div>
  )
}
