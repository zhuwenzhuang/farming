import type { FarmingTerminal } from '@/lib/terminal-engine'
import { terminalImeOverlayStyle } from '@/lib/terminal-ime'
import {
  normalizeTerminalSelectionForCopy,
  type TerminalSelectionController,
} from '@/lib/terminal-selection'
import {
  isTerminalPathOpenClick,
  type TerminalLinkInteractionController,
} from '@/lib/terminal-link-interaction'
import type { TerminalAttachmentOperation } from '@/lib/terminal-attachment-coordinator'
import type { TerminalRendererEffectController } from '@/lib/terminal-renderer-effects'
import { readClipboardText, writeClipboardText } from '@/lib/clipboard'
import {
  shouldBlockDetachedTerminalPaste,
  shouldHandleTerminalPasteEvent,
} from '@/lib/terminal-input'
import { isTouchInputViewport } from '@/lib/responsive-mode'
import { TerminalTouchInteractionController } from '@/lib/terminal-touch-interaction-controller'
import { showUrlOpenMenu } from '@/lib/url-open-menu'
import type { TerminalPathOpenTarget } from '@/lib/terminal-links'

interface TerminalInteractionViewportPorts {
  pageScroll: (direction: 'PageUp' | 'PageDown') => void
  onScrollIntent: (event: Event) => void
  lineHeight: () => number
  viewportY: () => number
  scrollToViewportY: (viewportY: number) => void
  onTouchViewportChanged: () => void
}

interface TerminalInteractionInputPorts {
  disabled: () => boolean
  send: (input: string) => boolean
  clear: () => void
}

interface TerminalInteractionLinkPorts {
  controller: TerminalLinkInteractionController
  pathOpenHandler: () => ((agentId: string, target: TerminalPathOpenTarget) => void) | null
  farmingUrlOpenHandler: () => ((agentId: string, url: string) => void) | null
}

export interface TerminalSessionInteractionPorts {
  agentId: string
  hostEl: HTMLDivElement
  terminal: FarmingTerminal
  isXterm: boolean
  fontFamily: string
  selection: TerminalSelectionController
  rendererEffects: TerminalRendererEffectController
  link: TerminalInteractionLinkPorts
  viewport: TerminalInteractionViewportPorts
  input: TerminalInteractionInputPorts
  isDisposed: () => boolean
  isAttached: () => boolean
  focusInput: () => boolean
  focusRevision: () => number
  mayRestoreFocus: (menu: HTMLElement, revision: number) => boolean
  attachmentOperation: () => TerminalAttachmentOperation
  isCurrentAttachmentOperation: (operation: TerminalAttachmentOperation) => boolean
  readFontSize: () => number
}

function isTextEditingCopyTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false
  return Boolean(target.closest([
    '.code-composer',
    '.code-terminal-search',
    '.code-file-editor',
    '.monaco-editor',
    'input',
    'textarea',
    'select',
    '[contenteditable="true"]',
    '[role="dialog"]',
    '[role="menu"]',
  ].join(',')))
}

function isTerminalCopyShortcut(event: KeyboardEvent) {
  if (event.key.toLowerCase() !== 'c' || event.altKey || event.shiftKey) return false
  if (event.metaKey && !event.ctrlKey) return true
  const isMac = navigator.platform.toLowerCase().includes('mac')
  return !isMac && event.ctrlKey && !event.metaKey
}

function isTerminalClearShortcut(event: KeyboardEvent) {
  if (event.key.toLowerCase() !== 'k' || event.altKey || event.shiftKey || event.ctrlKey) return false
  return navigator.platform.toLowerCase().includes('mac') && event.metaKey
}

function terminalContextMenuLabel(action: 'copy' | 'paste' | 'selectAll' | 'clear') {
  const lang = document.documentElement.lang || navigator.language || ''
  const zh = lang.toLowerCase().startsWith('zh')
  if (action === 'copy') return zh ? '复制' : 'Copy'
  if (action === 'paste') return zh ? '粘贴' : 'Paste'
  if (action === 'clear') return zh ? '清除' : 'Clear'
  return zh ? '全选' : 'Select All'
}

function clampContextMenuPosition(x: number, y: number, width = 160, height = 148) {
  const margin = 8
  return {
    x: Math.max(margin, Math.min(x, window.innerWidth - width - margin)),
    y: Math.max(margin, Math.min(y, window.innerHeight - height - margin)),
  }
}

function createTerminalContextMenuItem(
  label: string,
  onClick: () => void,
  options: { disabled?: boolean } = {},
) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'terminal-context-menu-item'
  button.setAttribute('role', 'menuitem')
  button.textContent = label
  button.disabled = options.disabled === true
  button.addEventListener('click', () => {
    if (!button.disabled) onClick()
  })
  return button
}

/** Owns terminal DOM interaction listeners, transient selection, menus, IME, links, and touch. */
export class TerminalSessionInteractionController {
  readonly #ports: TerminalSessionInteractionPorts
  readonly #listenerRemovals: Array<() => void> = []
  readonly #imeDisposables: Array<() => void> = []
  #touch: TerminalTouchInteractionController | null = null
  #contextMenuEl: HTMLDivElement | null = null
  #contextMenuCleanup: (() => void) | null = null
  #installed = false
  #disposed = false

  constructor(ports: TerminalSessionInteractionPorts) {
    this.#ports = ports
  }

  get link() {
    return this.#ports.link.controller
  }

  install() {
    if (this.#installed || this.#disposed) return false
    this.#installed = true
    this.#ports.selection.install()
    this.link.install()
    this.#installImeOverlay()
    this.#installContextMenu()
    this.#installSelectionInputAndScroll()
    this.#touch = new TerminalTouchInteractionController({
      hostEl: this.#ports.hostEl,
      isDisposed: () => this.#isDisposed(),
      copyTextAtEvent: event => this.copyTextAtEvent(event),
      showContextMenu: (event, copyText) => this.showContextMenu(event, copyText),
      lineHeight: this.#ports.viewport.lineHeight,
      viewportY: this.#ports.viewport.viewportY,
      scrollToViewportY: this.#ports.viewport.scrollToViewportY,
      onViewportChanged: this.#ports.viewport.onTouchViewportChanged,
      hideContextMenu: () => this.hideContextMenu(),
    })
    this.#touch.install()
    return true
  }

  dispose() {
    if (this.#disposed) return false
    this.#disposed = true
    this.#listenerRemovals.splice(0).reverse().forEach(remove => remove())
    this.#imeDisposables.splice(0).reverse().forEach(dispose => dispose())
    this.#touch?.dispose()
    this.#touch = null
    this.hideContextMenu()
    this.link.dispose()
    this.#ports.selection.dispose()
    return true
  }

  reset() {
    this.hideContextMenu()
    this.link.reset()
    this.#ports.selection.clear()
  }

  clearAfterInput() {
    this.#ports.selection.clearTransient()
  }

  stopTouchMomentum() {
    this.#touch?.stopTouchMomentum()
  }

  refreshImeOverlay() {
    this.#updateImeOverlay()
  }

  scheduleImeOverlayUpdateIfActive() {
    if (!this.#ports.rendererEffects.isImeComposing) return
    requestAnimationFrame(() => {
      if (!this.#isDisposed() && this.#ports.rendererEffects.isImeComposing) this.#updateImeOverlay()
    })
  }

  copyTextAtEvent(event: MouseEvent) {
    const selectionOwner = this.#ports.selection
    const selection = selectionOwner.selectionForCopy()
      || selectionOwner.contextMenuSelection
      || selectionOwner.lastNonEmptySelection
    const url = this.link.urlAtEvent(event)
    const pathLink = this.#ports.link.pathOpenHandler() ? this.link.resolvedPathLinkAtEvent(event) : null
    const selectionAtEvent = Boolean(selection) && selectionOwner.eventInsideSelection(event)
    const compactSelection = selection.replace(/\s+/g, '')
    if (url && (!selectionAtEvent || url.includes(compactSelection))) return url
    if (pathLink?.text && (!selectionAtEvent || pathLink.text.includes(compactSelection))) return pathLink.text
    if (selection) return selection
    const cell = selectionOwner.cellFromEvent(event)
    return cell ? selectionOwner.selectContinuousTextAtCell(cell.col, cell.row) : ''
  }

  showContextMenu(event: MouseEvent, selection: string) {
    this.hideContextMenu()
    const menu = document.createElement('div')
    const position = clampContextMenuPosition(event.clientX, event.clientY)
    menu.className = 'terminal-context-menu terminal-context-menu-pooled'
    menu.setAttribute('data-testid', 'code-terminal-context-menu')
    menu.setAttribute('role', 'menu')
    menu.style.left = `${position.x}px`
    menu.style.top = `${position.y}px`

    const copyButton = createTerminalContextMenuItem(terminalContextMenuLabel('copy'), () => {
      const focusRevision = this.#ports.focusRevision()
      void writeClipboardText(selection).finally(() => {
        const restoreFocus = this.#ports.mayRestoreFocus(menu, focusRevision)
        this.hideContextMenu()
        if (!isTouchInputViewport() && restoreFocus) this.#ports.focusInput()
      })
    }, { disabled: !selection })
    const pasteButton = createTerminalContextMenuItem(terminalContextMenuLabel('paste'), () => {
      const focusRevision = this.#ports.focusRevision()
      void readClipboardText().then(text => this.#paste(text)).finally(() => {
        const restoreFocus = this.#ports.mayRestoreFocus(menu, focusRevision)
        this.hideContextMenu()
        if (!isTouchInputViewport() && restoreFocus) this.#ports.focusInput()
      })
    })
    const selectAllButton = createTerminalContextMenuItem(terminalContextMenuLabel('selectAll'), () => {
      this.hideContextMenu()
      this.#ports.selection.clear()
      requestAnimationFrame(() => {
        if (this.#isDisposed()) return
        this.#ports.selection.contextMenuSelection = this.#ports.selection.selectBuffer()
        if (!isTouchInputViewport()) this.#ports.focusInput()
      })
    }, {
      disabled: typeof this.#ports.terminal.select !== 'function' || !this.#ports.terminal.buffer?.active,
    })
    const clearButton = createTerminalContextMenuItem(terminalContextMenuLabel('clear'), () => {
      this.hideContextMenu()
      this.#ports.input.clear()
      if (!isTouchInputViewport()) this.#ports.focusInput()
    })

    menu.addEventListener('mousedown', event => event.stopPropagation())
    menu.addEventListener('pointerdown', event => event.stopPropagation())
    menu.addEventListener('keydown', event => {
      if (!(event.target instanceof HTMLButtonElement)) return
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
      const index = items.indexOf(event.target)
      if (index < 0 || items.length === 0) return
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      items[(index + direction + items.length) % items.length]?.focus()
    })
    menu.append(copyButton, pasteButton, selectAllButton, clearButton)
    document.body.appendChild(menu)
    this.#contextMenuEl = menu

    const closeOutside = (pointerEvent: MouseEvent | PointerEvent) => {
      if (!(pointerEvent.target instanceof Node) || !menu.contains(pointerEvent.target)) this.hideContextMenu()
    }
    const closeKey = (keyboardEvent: KeyboardEvent) => {
      if (keyboardEvent.key !== 'Escape') return
      keyboardEvent.preventDefault()
      this.hideContextMenu()
      if (!isTouchInputViewport()) this.#ports.focusInput()
    }
    const close = () => this.hideContextMenu()
    document.addEventListener('mousedown', closeOutside, true)
    document.addEventListener('pointerdown', closeOutside, true)
    document.addEventListener('keydown', closeKey, true)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    this.#contextMenuCleanup = () => {
      document.removeEventListener('mousedown', closeOutside, true)
      document.removeEventListener('pointerdown', closeOutside, true)
      document.removeEventListener('keydown', closeKey, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
    if (event.button === 0 && !('pointerType' in event)) {
      requestAnimationFrame(() => menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus())
    }
  }

  hideContextMenu() {
    this.#contextMenuCleanup?.()
    this.#contextMenuCleanup = null
    this.#contextMenuEl?.remove()
    this.#contextMenuEl = null
    this.#ports.selection.contextMenuSelection = ''
  }

  #isDisposed() {
    return this.#disposed || this.#ports.isDisposed()
  }

  #listen(target: EventTarget, type: string, listener: EventListener, capture = false) {
    target.addEventListener(type, listener, capture)
    this.#listenerRemovals.push(() => target.removeEventListener(type, listener, capture))
  }

  #shouldHandleCopy(target: EventTarget | null) {
    if (this.#isDisposed() || !this.#ports.isAttached()) return false
    if (target instanceof Node && this.#ports.hostEl.contains(target)) return true
    if (isTextEditingCopyTarget(target)) return false
    const selection = window.getSelection?.()
    if (!selection || selection.isCollapsed) return true
    return Boolean(
      (selection.anchorNode && this.#ports.hostEl.contains(selection.anchorNode))
      || (selection.focusNode && this.#ports.hostEl.contains(selection.focusNode)),
    )
  }

  #paste(text: string) {
    if (!text || this.#isDisposed() || !this.#ports.isAttached()) return false
    return this.#ports.input.send(text)
  }

  #installContextMenu() {
    const contextMenu = (event: MouseEvent) => {
      if (!(event.target instanceof Node) || !this.#ports.hostEl.contains(event.target)) return
      const url = this.link.urlAtEvent(event)
      if (url) {
        const farmingHandler = this.#ports.link.farmingUrlOpenHandler()
        showUrlOpenMenu({
          event,
          url,
          onOpenInFarming: farmingHandler ? () => farmingHandler(this.#ports.agentId, url) : undefined,
        })
        return
      }
      const pathOpenHandler = this.#ports.link.pathOpenHandler()
      const rawPathLink = pathOpenHandler
        ? this.link.resolvedPathLinkAtEvent(event) ?? this.link.pathLinkAtEvent(event)
        : null
      if (rawPathLink?.pathTarget) {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
        const operation = this.#ports.attachmentOperation()
        void this.link.resolvePathTarget(rawPathLink.pathTarget).then(resolved => {
          if (!this.#ports.isCurrentAttachmentOperation(operation)) return
          this.showContextMenu(event, resolved ? rawPathLink.text : this.copyTextAtEvent(event))
        })
        return
      }
      if (pathOpenHandler && isTerminalPathOpenClick(event)) {
        const pathTarget = this.link.resolvedPathTargetAtEvent(event)
        if (pathTarget) {
          event.preventDefault()
          event.stopPropagation()
          event.stopImmediatePropagation()
          pathOpenHandler(this.#ports.agentId, pathTarget)
          return
        }
      }
      const copyText = this.copyTextAtEvent(event)
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      this.showContextMenu(event, copyText)
    }
    const mouseDown = (event: MouseEvent) => {
      if (!(event.target instanceof Node) || !this.#ports.hostEl.contains(event.target)) return
      if (event.button === 0) {
        this.#ports.selection.clearTransient()
      } else if (event.button === 2) {
        this.#ports.selection.contextMenuSelection = this.#ports.selection.selectionForCopy()
          || normalizeTerminalSelectionForCopy(this.#ports.selection.cachedSelection)
          || this.#ports.selection.lastNonEmptySelection
      }
    }
    this.#listen(window, 'mousedown', mouseDown as EventListener, true)
    this.#listen(window, 'contextmenu', contextMenu as EventListener, true)
    this.#listen(this.#ports.hostEl, 'mousedown', mouseDown as EventListener, true)
    this.#listen(this.#ports.hostEl, 'contextmenu', contextMenu as EventListener, true)
  }

  #installSelectionInputAndScroll() {
    const terminal = this.#ports.terminal
    const selection = this.#ports.selection
    if (!this.#ports.isXterm) {
      const pointerDown = (event: PointerEvent) => {
        if (event.pointerType === 'touch' || !selection.startDrag(event, isTouchInputViewport(), event.pointerId)) return
        try { this.#ports.hostEl.setPointerCapture(event.pointerId) } catch { /* window listeners remain */ }
      }
      const pointerMove = (event: PointerEvent) => {
        if (event.pointerType !== 'touch') selection.updateDrag(event)
      }
      const pointerUp = (event: PointerEvent) => {
        if (event.pointerType === 'touch') return
        const finished = selection.finishDrag(event)
        if (finished) this.link.suppressActivation()
        else this.link.activateOpenTargetAtEvent(event)
        if (finished || this.link.isActivationSuppressed) {
          try { this.#ports.hostEl.releasePointerCapture(event.pointerId) } catch { /* ignore */ }
        }
      }
      const mouseDown = (event: MouseEvent) => {
        if (!selection.hasDrag()) selection.startDrag(event, isTouchInputViewport())
      }
      this.#listen(this.#ports.hostEl, 'pointerdown', pointerDown as EventListener, true)
      this.#listen(window, 'pointermove', pointerMove as EventListener, true)
      this.#listen(window, 'pointerup', pointerUp as EventListener, true)
      this.#listen(window, 'pointercancel', pointerUp as EventListener, true)
      this.#listen(this.#ports.hostEl, 'mousedown', mouseDown as EventListener, true)
      this.#listen(window, 'mousemove', (event => selection.updateDrag(event as MouseEvent)) as EventListener, true)
      this.#listen(window, 'mouseup', (event => selection.finishDrag(event as MouseEvent)) as EventListener, true)
    }

    this.#listen(this.#ports.hostEl, 'dblclick', ((event: MouseEvent) => {
      if (this.#ports.isXterm || isTouchInputViewport()) return
      const cell = selection.cellFromEvent(event)
      if (!cell || !selection.selectContinuousTextAtCell(cell.col, cell.row)) return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
    }) as EventListener, true)

    const copy = (event: ClipboardEvent) => {
      if (!this.#shouldHandleCopy(event.target)) return
      const text = selection.selectionForCopy({ includeNativeFallback: true })
      if (!text) return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      event.clipboardData?.setData('text/plain', text)
    }
    this.#listen(this.#ports.hostEl, 'copy', copy as EventListener, true)
    this.#listen(document, 'copy', copy as EventListener, true)

    const copyKeydown = (event: KeyboardEvent) => {
      if (!isTerminalCopyShortcut(event) || !this.#shouldHandleCopy(event.target)) return
      const text = selection.selectionForCopy({ includeNativeFallback: true })
      if (!text) return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      void writeClipboardText(text)
    }
    this.#listen(document, 'keydown', copyKeydown as EventListener, true)

    const controlKeydown = (event: KeyboardEvent) => {
      if (isTerminalClearShortcut(event) && this.#ports.isAttached()) {
        const target = event.target
        if (!(target instanceof Node) || !this.#ports.hostEl.contains(target)) return
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
        this.#ports.input.clear()
        return
      }
      if ((event.key === 'PageUp' || event.key === 'PageDown') && this.#ports.isAttached()) {
        const target = event.target
        if (!(target instanceof Node) || !this.#ports.hostEl.contains(target)) return
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
        this.#ports.viewport.pageScroll(event.key)
      }
    }
    if (terminal.attachCustomKeyEventHandler) {
      terminal.attachCustomKeyEventHandler(event => {
        const before = event.defaultPrevented
        controlKeydown(event)
        return before === event.defaultPrevented
      })
    } else {
      this.#listen(document, 'keydown', controlKeydown as EventListener, true)
      this.#listen(this.#ports.hostEl, 'keydown', controlKeydown as EventListener, true)
    }

    const paste = (event: ClipboardEvent) => {
      const attached = this.#ports.isAttached()
      if (shouldBlockDetachedTerminalPaste(this.#ports.hostEl, event, attached)) {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
        return
      }
      if (!shouldHandleTerminalPasteEvent(this.#ports.hostEl, event, attached) || this.#ports.isXterm) return
      if (!this.#paste(event.clipboardData?.getData('text/plain') || '')) return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
    }
    this.#listen(window, 'paste', paste as EventListener, true)
    this.#listen(this.#ports.hostEl, 'paste', paste as EventListener, true)
    this.#listen(this.#ports.hostEl, 'wheel', this.#ports.viewport.onScrollIntent as EventListener, true)
    this.#listen(this.#ports.hostEl, 'pointerup', this.#ports.viewport.onScrollIntent as EventListener, true)
  }

  #updateImeOverlay() {
    const input = this.#ports.hostEl.querySelector('textarea')
    const metrics = this.#ports.terminal.renderer?.getMetrics?.()
    const cursor = this.#ports.terminal.wasmTerm?.getCursor?.()
    if (!(input instanceof HTMLTextAreaElement) || !metrics || !cursor) return
    const style = terminalImeOverlayStyle(cursor, metrics, this.#ports.readFontSize(), this.#ports.fontFamily)
    if (!style) return
    input.classList.add('terminal-ime-input')
    Object.assign(input.style, style)
  }

  #installImeOverlay() {
    if (this.#ports.isXterm) return
    const input = this.#ports.hostEl.querySelector('textarea')
    if (!(input instanceof HTMLTextAreaElement)) return
    const sync = () => { if (!this.#isDisposed()) this.#updateImeOverlay() }
    const rafSync = () => requestAnimationFrame(sync)
    const rafSyncIfComposing = () => {
      if (this.#ports.rendererEffects.isImeComposing) rafSync()
    }
    const activate = () => {
      sync()
      this.#ports.hostEl.classList.add('terminal-ime-active')
      input.classList.add('terminal-ime-composing')
      this.#ports.rendererEffects.beginImeComposition()
    }
    const finish = () => {
      this.#ports.rendererEffects.endImeComposition()
      requestAnimationFrame(() => {
        this.#ports.hostEl.classList.remove('terminal-ime-active')
        input.classList.remove('terminal-ime-composing')
        input.value = ''
        sync()
      })
    }
    const cancel = () => {
      this.#ports.rendererEffects.endImeComposition()
      this.#ports.hostEl.classList.remove('terminal-ime-active')
      input.classList.remove('terminal-ime-composing')
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) activate()
    }
    const listen = (target: EventTarget, type: string, listener: EventListener, capture = false) => {
      target.addEventListener(type, listener, capture)
      this.#imeDisposables.push(() => target.removeEventListener(type, listener, capture))
    }
    listen(input, 'focus', sync)
    listen(this.#ports.hostEl, 'keydown', keydown as EventListener, true)
    listen(this.#ports.hostEl, 'compositionstart', activate, true)
    listen(this.#ports.hostEl, 'compositionupdate', sync, true)
    listen(this.#ports.hostEl, 'compositionend', finish, true)
    listen(input, 'input', rafSyncIfComposing)
    listen(input, 'blur', cancel)
    const cursorMove = this.#ports.terminal.onCursorMove?.(rafSyncIfComposing)
    const key = this.#ports.terminal.onKey?.(rafSyncIfComposing)
    if (cursorMove) this.#imeDisposables.push(() => cursorMove.dispose())
    if (key) this.#imeDisposables.push(() => key.dispose())
    this.#imeDisposables.push(cancel)
    sync()
  }
}
