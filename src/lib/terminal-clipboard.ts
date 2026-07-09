export interface TerminalClipboardProvider {
  readText: (selection: string) => Promise<string> | string
  writeText: (selection: string, text: string) => Promise<void> | undefined
}

export async function readTerminalClipboardText() {
  try {
    if (navigator.clipboard?.readText) {
      return await navigator.clipboard.readText()
    }
  } catch {
    return ''
  }
  return ''
}

export async function writeTerminalClipboardText(text: string) {
  if (!text) return false

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through to the textarea copy path.
  }

  const previousActiveElement = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null
  const selection = document.getSelection()
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index))
    : []
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
  textarea.style.left = '-9999px'
  textarea.style.top = '0'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  try {
    if (document.execCommand('copy')) {
      return true
    }
  } catch {
    // Fall through to the async clipboard API.
  } finally {
    textarea.remove()
    if (selection) {
      selection.removeAllRanges()
      ranges.forEach(range => selection.addRange(range))
    }
    previousActiveElement?.focus()
  }

  try {
    await navigator.clipboard?.writeText(text)
    return true
  } catch {
    // Best effort: clipboard failures should never break the terminal session.
  }
  return false
}

export function createTerminalClipboardProvider(): TerminalClipboardProvider {
  return {
    readText(selection) {
      return selection === 'c' ? readTerminalClipboardText() : ''
    },
    writeText(selection, text) {
      return selection === 'c' ? writeTerminalClipboardText(text).then(() => undefined) : undefined
    },
  }
}
