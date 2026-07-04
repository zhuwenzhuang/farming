import { useEffect, useRef, useCallback } from 'react'
import { getTerminalSequenceForKey, getControlChar, isBrowserShortcut } from '@/lib/terminal-keys'

interface UseIMEBridgeOptions {
  active: boolean
  onInput: (data: string) => void
}

/**
 * Hidden input element for IME/CJK input composition.
 * Passive by default — only activates during IME composition.
 * All regular keyboard input is handled by the ghostty terminal via onData.
 */
export function useIMEBridge({ active, onInput }: UseIMEBridgeOptions) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const composingRef = useRef(false)
  const onInputRef = useRef(onInput)
  const lastBackspaceRef = useRef(0)
  const lastDeleteRef = useRef(0)

  onInputRef.current = onInput

  const resetValue = useCallback(() => {
    if (!inputRef.current) return
    inputRef.current.value = ' '
    inputRef.current.setSelectionRange(1, 1)
  }, [])

  const focusBridge = useCallback(() => {
    if (!inputRef.current) return
    inputRef.current.focus()
    resetValue()
  }, [resetValue])

  useEffect(() => {
    if (!active) return

    const input = document.createElement('input')
    input.type = 'text'
    input.setAttribute('autocomplete', 'off')
    input.setAttribute('autocorrect', 'off')
    input.setAttribute('autocapitalize', 'off')
    input.setAttribute('spellcheck', 'false')
    input.setAttribute('inputmode', 'text')
    input.setAttribute('aria-hidden', 'true')
    Object.assign(input.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      width: '200px',
      height: '24px',
      opacity: '0.01',
      background: 'transparent',
      color: 'transparent',
      caretColor: 'transparent',
      border: 'none',
      outline: 'none',
      fontSize: '16px',
      pointerEvents: 'none',
      zIndex: '2',
    })

    const doReset = () => {
      input.value = ' '
      input.setSelectionRange(1, 1)
    }

    input.addEventListener('compositionstart', () => {
      composingRef.current = true
      document.body.setAttribute('data-ime-composing', 'true')
    })

    input.addEventListener('compositionend', (e) => {
      composingRef.current = false
      document.body.removeAttribute('data-ime-composing')
      if (e.data) {
        onInputRef.current(e.data)
      }
      doReset()
    })

    input.addEventListener('beforeinput', (e) => {
      if (composingRef.current) return
      if (e.inputType === 'insertText' && e.data) {
        e.preventDefault()
        onInputRef.current(e.data)
        doReset()
      }
    })

    input.addEventListener('keydown', (e) => {
      if (e.defaultPrevented || composingRef.current) return
      if (isBrowserShortcut(e)) return

      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1 && e.key !== 'Enter') {
        const controlChar = getControlChar(e.key)
        if (controlChar) {
          e.preventDefault()
          onInputRef.current(controlChar)
          doReset()
        }
        return
      }

      const sequence = getTerminalSequenceForKey(e)
      if (sequence) {
        e.preventDefault()
        onInputRef.current(sequence)
        doReset()
      }
    })

    input.addEventListener('input', (e) => {
      if (composingRef.current) return
      const ie = e as InputEvent
      if (ie.inputType === 'deleteContentBackward') {
        const now = Date.now()
        if (now - lastBackspaceRef.current > 50) {
          onInputRef.current('\x7f')
        }
        lastBackspaceRef.current = now
        requestAnimationFrame(() => {
          if (document.activeElement === input) doReset()
        })
        return
      }
      if (ie.inputType === 'deleteContentForward') {
        const now = Date.now()
        if (now - lastDeleteRef.current > 50) {
          onInputRef.current('\x1b[3~')
        }
        lastDeleteRef.current = now
        requestAnimationFrame(() => {
          if (document.activeElement === input) doReset()
        })
        return
      }
      doReset()
    })

    input.addEventListener('focus', () => {
      document.body.setAttribute('data-ime-input-focused', 'true')
      requestAnimationFrame(() => {
        if (document.activeElement === input) doReset()
      })
    })

    input.addEventListener('blur', () => {
      document.body.removeAttribute('data-ime-input-focused')
      // Do NOT re-steal focus — let the ghostty terminal keep it
    })

    document.body.appendChild(input)
    inputRef.current = input
    doReset()

    return () => {
      input.remove()
      inputRef.current = null
      composingRef.current = false
      document.body.removeAttribute('data-ime-input-focused')
      document.body.removeAttribute('data-ime-composing')
    }
  }, [active])

  return { focusBridge }
}
