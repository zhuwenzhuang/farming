import { useEffect, useRef, useCallback, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type { Agent } from '@/types/agent'
import { ArrowDownGlyph, ArrowUpGlyph } from '@/components/IconGlyphs'
import { agentTitle } from '@/lib/format'
import { usePooledTerminal } from '@/hooks/usePooledTerminal'
import { sendTerminalSessionInput } from '@/lib/terminal-session-pool'
import { applyThemeAppearance } from '@/lib/theme'
import {
  isBrowserShortcut,
  isCopyShortcut,
  isPasteShortcut,
} from '@/lib/terminal-keys'

interface SessionModalProps {
  agent: Agent | null
  onClose: () => void
  onKill: (agentId: string) => void
  onSessionOutput: (agentId: string, handler: (data: string, replace?: boolean, outputSeq?: number | null, runtimeEpoch?: string, stateRevision?: number | null, cols?: number, rows?: number, kind?: 'output' | 'resize' | 'clear') => void) => () => void
}

function canUseClipboardWrite() {
  return typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function'
}

function canUseClipboardRead() {
  return typeof navigator !== 'undefined' && typeof navigator.clipboard?.readText === 'function'
}

function shouldSuppressRendererCursorForAgent(command?: string) {
  const program = String(command || '').trim().split(/\s+/)[0] || ''
  return [
    'claude',
    'codex',
    'qwen',
    'opencode',
    'aider',
    'github-copilot-cli',
    'amazon-q',
  ].includes(program)
}

function fallbackCopyText(text: string) {
  if (typeof document === 'undefined' || !text) return false

  const previousActiveElement = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', 'true')
  textarea.setAttribute('autocomplete', 'off')
  textarea.setAttribute('autocorrect', 'off')
  textarea.setAttribute('autocapitalize', 'none')
  textarea.setAttribute('spellcheck', 'false')
  textarea.setAttribute('data-lpignore', 'true')
  textarea.setAttribute('data-1p-ignore', 'true')
  textarea.setAttribute('data-bwignore', 'true')
  textarea.setAttribute('data-form-type', 'other')
  textarea.style.position = 'fixed'
  textarea.style.left = '-10000px'
  textarea.style.top = '-10000px'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)

  const selection = document.getSelection()
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index)) : []

  textarea.focus()
  textarea.select()

  let success = false
  try {
    success = document.execCommand('copy')
  } catch {
    success = false
  }

  textarea.remove()

  if (selection) {
    selection.removeAllRanges()
    ranges.forEach((range) => selection.addRange(range))
  }

  previousActiveElement?.focus()

  return success
}

function writeClipboardText(text: string) {
  if (!text) return false

  if (fallbackCopyText(text)) {
    return true
  }

  if (canUseClipboardWrite()) {
    navigator.clipboard?.writeText(text).catch(() => {})
    return true
  }

  return false
}

export function SessionModal({
  agent,
  onClose,
  onKill,
  onSessionOutput,
}: SessionModalProps) {
  const terminalContainerRef = useRef<HTMLDivElement>(null)
  const agentIdRef = useRef<string | null>(null)
  const terminalReadyRef = useRef(false)
  const mobileInputRef = useRef<HTMLInputElement>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const [mobileInputValue, setMobileInputValue] = useState('')
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    selection: string
    canPaste: boolean
  } | null>(null)
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false)

  agentIdRef.current = agent?.id ?? null

  const handleTerminalInput = useCallback((data: string) => {
    if (agentIdRef.current) {
      sendTerminalSessionInput(agentIdRef.current, data)
    }
  }, [])

  const handleTerminalReady = useCallback(() => {
    terminalReadyRef.current = true
  }, [])

  const isMobileViewport = useCallback(() => {
    if (typeof window === 'undefined') return false
    return window.matchMedia('(max-width: 980px)').matches
  }, [])

  const { focus, getSelection, getSelectionNow } = usePooledTerminal({
    agentId: agent?.id ?? null,
    containerRef: terminalContainerRef,
    onSessionOutput,
    suppressRendererCursor: shouldSuppressRendererCursorForAgent(agent?.command),
    onReady: handleTerminalReady,
  })

  const handleTerminalContainerInteract = useCallback(() => {
    setContextMenu(null)

    if (isMobileViewport()) {
      return
    }

    focus()
  }, [focus, isMobileViewport])

  // Toggle body.session-open
  useEffect(() => {
    if (!agent) return
    document.body.classList.add('session-open')
    applyThemeAppearance(document.body.dataset.theme || 'terminal', {
      crtEffects: document.body.dataset.crtEffects !== 'off',
    })
    return () => { document.body.classList.remove('session-open') }
  }, [agent])

  useEffect(() => {
    if (!agent) return

    const closeContextMenu = (event?: Event) => {
      const target = event?.target
      if (target instanceof Node && contextMenuRef.current?.contains(target)) {
        return
      }
      setContextMenu(null)
    }
    window.addEventListener('pointerdown', closeContextMenu, true)
    window.addEventListener('scroll', closeContextMenu, true)

    return () => {
      window.removeEventListener('pointerdown', closeContextMenu, true)
      window.removeEventListener('scroll', closeContextMenu, true)
    }
  }, [agent])

  // Bootstrap + streaming subscription handled by usePooledTerminal

  // Only intercept app-level shortcuts (close, kill, copy, paste).
  // All other key input is handled by the ghostty terminal itself via terminal.onData.
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!agentIdRef.current) return

    const isCtrlOrCmd = e.ctrlKey || e.metaKey

    // Ctrl/Cmd + Escape → close session
    if (isCtrlOrCmd && e.key === 'Escape') {
      setContextMenu(null)
      e.preventDefault()
      onClose()
      return
    }

    // Ctrl/Cmd + K → kill agent
    if (isCtrlOrCmd && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault()
      onKill(agentIdRef.current)
      return
    }

    // Copy shortcut — copy selection, or send Ctrl+C if no selection
    if (isCopyShortcut(e)) {
      const domSelection = window.getSelection()?.toString() ?? ''
      const ghosttySelection = agentIdRef.current ? getSelectionNow() : ''
      const sel = ghosttySelection || domSelection
      if (sel) {
        e.preventDefault()
        e.stopPropagation()
        writeClipboardText(sel)
        return
      }
      if (e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        sendTerminalSessionInput(agentIdRef.current, '\x03')
        return
      }
      return
    }

    // Paste shortcut
    if (isPasteShortcut(e)) {
      if (!canUseClipboardRead()) {
        return
      }
      e.preventDefault()
      navigator.clipboard?.readText().then(text => {
        if (text && agentIdRef.current) {
          sendTerminalSessionInput(agentIdRef.current, text.replace(/\r\n/g, '\n'))
          focus()
        }
      }).catch(() => {})
      return
    }

    // Let browser shortcuts through (Cmd+T, Cmd+W, etc.)
    if (isBrowserShortcut(e)) return

    // Everything else: let the terminal handle it natively.
  }, [onClose, onKill, focus, getSelectionNow])

  useEffect(() => {
    if (!agent) return
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [agent, handleKeyDown])

  const handleCopy = useCallback((e: ClipboardEvent) => {
    if (!agentIdRef.current) return

    const domSelection = window.getSelection()?.toString() ?? ''
    const selection = getSelectionNow() || domSelection
    if (!selection) return

    e.preventDefault()
    e.stopPropagation()
    if (e.clipboardData) {
      e.clipboardData.setData('text/plain', selection)
      return
    }

    writeClipboardText(selection)
  }, [getSelectionNow])

  useEffect(() => {
    if (!agent) return
    window.addEventListener('copy', handleCopy, true)
    return () => window.removeEventListener('copy', handleCopy, true)
  }, [agent, handleCopy])

  useEffect(() => {
    if (!agent) return
    setMobileActionsOpen(false)
    if (isMobileViewport()) return
    focus()
  }, [agent, focus, isMobileViewport])

  const sendMobileKey = useCallback((sequence: string) => {
    handleTerminalInput(sequence)
    if (isMobileViewport()) return
    focus()
  }, [handleTerminalInput, focus, isMobileViewport])

  const submitMobileInput = useCallback(() => {
    const value = mobileInputValue
    if (value) {
      handleTerminalInput(value)
    }
    handleTerminalInput('\r')
    if (value) {
      setMobileInputValue('')
    }
    mobileInputRef.current?.focus()
    if (!isMobileViewport()) {
      focus()
    }
  }, [mobileInputValue, handleTerminalInput, focus, isMobileViewport])

  const handleContextMenu = useCallback(async (e: ReactMouseEvent<HTMLDivElement>) => {
    if (isMobileViewport()) return

    const canRead = canUseClipboardRead()
    e.preventDefault()
    e.stopPropagation()

    const selection = agentIdRef.current ? await getSelection() : ''
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      selection,
      canPaste: canRead,
    })
  }, [getSelection, isMobileViewport])

  const handleCopySelection = useCallback(() => {
    if (!contextMenu?.selection) return
    writeClipboardText(contextMenu.selection)
    setContextMenu(null)
    focus()
  }, [contextMenu, focus])

  const handlePasteClipboard = useCallback(() => {
    if (!contextMenu?.canPaste || !agentIdRef.current) return
    navigator.clipboard?.readText().then((text) => {
      if (!text || !agentIdRef.current) return
      sendTerminalSessionInput(agentIdRef.current, text.replace(/\r\n/g, '\n'))
      focus()
    }).catch(() => {}).finally(() => {
      setContextMenu(null)
      focus()
    })
  }, [contextMenu, focus])

  if (!agent) return null

  return (
    <div className="session-modal" data-testid="session-modal">
      <div className="modal-content fx-crt-panel" data-testid="session-modal-content">
        <div className="session-header fx-crt-panel-compact" data-testid="session-header">
          <span className="session-title">
            {agentTitle(agent)} ({agent.id})
          </span>
          <button
            type="button"
            className="session-mobile-menu-btn"
            data-testid="session-mobile-menu"
            onClick={() => setMobileActionsOpen(open => !open)}
            aria-expanded={mobileActionsOpen}
          >
            Menu
          </button>
          <div className={`session-controls ${mobileActionsOpen ? 'session-controls-open' : ''}`}>
            <button className="kill-btn" data-testid="session-kill" onClick={() => onKill(agent.id)}>Kill [Ctrl+K]</button>
            <button className="close-btn" data-testid="session-close" onClick={onClose}>Close [Ctrl+Esc]</button>
          </div>
        </div>
        <div
          className="terminal-container fx-crt-screen"
          data-testid="terminal-container"
          ref={terminalContainerRef}
          onContextMenuCapture={handleContextMenu}
          onMouseDown={() => handleTerminalContainerInteract()}
          onPointerDown={() => handleTerminalContainerInteract()}
          onClick={() => handleTerminalContainerInteract()}
        />
        <div className="mobile-terminal-controls fx-crt-panel-compact" data-testid="mobile-terminal-controls">
          <div className="mobile-terminal-input-row" data-testid="mobile-terminal-input-row">
            <input
              ref={mobileInputRef}
              className="mobile-terminal-input"
              data-testid="mobile-terminal-input"
              type="text"
              value={mobileInputValue}
              onChange={(e) => setMobileInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  submitMobileInput()
                }
              }}
              placeholder="Type command or reply..."
              name="terminal-command"
              inputMode="text"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              enterKeyHint="send"
              data-lpignore="true"
              data-1p-ignore="true"
              data-bwignore="true"
              data-form-type="other"
            />
            <button type="button" data-testid="mobile-terminal-send" onClick={submitMobileInput}>Send</button>
          </div>
          <div className="mobile-terminal-nav-row" data-testid="mobile-terminal-nav-row">
            <button type="button" data-testid="mobile-terminal-up" aria-label="Up" onClick={() => sendMobileKey('\x1b[A')}><ArrowUpGlyph /></button>
            <button type="button" data-testid="mobile-terminal-down" aria-label="Down" onClick={() => sendMobileKey('\x1b[B')}><ArrowDownGlyph /></button>
          </div>
        </div>
        {contextMenu && (
          <div
            className="terminal-context-menu fx-crt-panel-compact"
            ref={contextMenuRef}
            style={{ left: contextMenu.x, top: contextMenu.y }}
            role="menu"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              className="terminal-context-menu-item"
              onClick={handleCopySelection}
              disabled={!contextMenu.selection}
            >
              Copy Selection
            </button>
            {contextMenu.canPaste && (
              <button
                type="button"
                role="menuitem"
                className="terminal-context-menu-item"
                onClick={handlePasteClipboard}
              >
                Paste
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
