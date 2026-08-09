import type { FarmingTerminal } from '@/lib/terminal-engine'

type TerminalRenderer = NonNullable<FarmingTerminal['renderer']>
type TerminalRender = NonNullable<TerminalRenderer['render']>

export interface TerminalRenderSuspensionLease {
  release: () => boolean
}

interface TerminalRendererEffectPorts {
  terminal: FarmingTerminal
  hostEl: HTMLElement
  supportsCursorSuppression: boolean
  initialCursorSuppressed?: boolean
  forceRender: () => void
}

interface RendererInstallation {
  renderer: TerminalRenderer
  originalRender: TerminalRender
  wrappedRender: TerminalRender
  cursorRestore: { visible: boolean | undefined } | null
}

export function stableTerminalScrollbarOpacity(scrollbarOpacity: number | undefined) {
  if (scrollbarOpacity === undefined) return scrollbarOpacity
  return scrollbarOpacity > 0 ? 1 : 0
}

/**
 * Owns renderer effects whose lifetimes cross writes, IME events, option
 * refreshes, and renderer replacement. Each caller expresses its effect as an
 * independent source or exact lease instead of mirroring renderer state.
 */
export class TerminalRendererEffectController {
  readonly #ports: TerminalRendererEffectPorts
  readonly #renderSuspensions = new Set<symbol>()
  #installation: RendererInstallation | null = null
  #attachmentCursorSuppressed: boolean
  #imeComposing = false
  #disposed = false

  constructor(ports: TerminalRendererEffectPorts) {
    this.#ports = ports
    this.#attachmentCursorSuppressed = ports.initialCursorSuppressed === true
  }

  get isImeComposing() {
    return this.#imeComposing
  }

  get isRenderingSuspended() {
    return this.#renderSuspensions.size > 0
  }

  install() {
    if (this.#disposed) return false
    const installation = this.#ensureInstallation()
    const shouldSuppress = this.#shouldSuppressCursor()
    this.#ports.hostEl.classList.toggle('terminal-renderer-cursor-suppressed', shouldSuppress)
    if (installation && shouldSuppress) installation.renderer.cursorVisible = false
    return installation !== null
  }

  setAttachmentCursorSuppressed(suppressed: boolean) {
    if (this.#disposed) return false
    const wasSuppressed = this.#shouldSuppressCursor()
    if (this.#attachmentCursorSuppressed === suppressed) {
      const installation = this.#ensureInstallation()
      this.#ports.hostEl.classList.toggle('terminal-renderer-cursor-suppressed', wasSuppressed)
      if (installation && wasSuppressed) installation.renderer.cursorVisible = false
      return true
    }
    this.#ensureInstallation()
    this.#attachmentCursorSuppressed = suppressed
    this.#applyCursorPolicy(wasSuppressed)
    return true
  }

  beginImeComposition() {
    if (this.#disposed || this.#imeComposing) return false
    const wasSuppressed = this.#shouldSuppressCursor()
    this.#ensureInstallation()
    this.#imeComposing = true
    this.#applyCursorPolicy(wasSuppressed)
    return true
  }

  endImeComposition() {
    if (this.#disposed || !this.#imeComposing) return false
    const wasSuppressed = this.#shouldSuppressCursor()
    this.#ensureInstallation()
    this.#imeComposing = false
    this.#applyCursorPolicy(wasSuppressed)
    return true
  }

  acquireRenderSuspension(): TerminalRenderSuspensionLease {
    if (this.#disposed) return { release: () => false }
    const token = Symbol('terminal-render-suspension')
    let released = false
    this.#renderSuspensions.add(token)
    return {
      release: () => {
        if (released) return false
        released = true
        return this.#renderSuspensions.delete(token)
      },
    }
  }

  dispose() {
    if (this.#disposed) return false
    this.#disposed = true
    this.#renderSuspensions.clear()
    this.#restoreInstalledRenderer()
    this.#ports.hostEl.classList.remove('terminal-renderer-cursor-suppressed')
    return true
  }

  #shouldSuppressCursor() {
    return this.#ports.supportsCursorSuppression
      && (this.#attachmentCursorSuppressed || this.#imeComposing)
  }

  #applyCursorPolicy(wasSuppressed: boolean) {
    const installation = this.#ensureInstallation()
    const shouldSuppress = this.#shouldSuppressCursor()
    this.#ports.hostEl.classList.toggle('terminal-renderer-cursor-suppressed', shouldSuppress)

    if (!installation) {
      this.#ports.forceRender()
      return
    }

    if (!wasSuppressed && shouldSuppress) {
      this.#captureCursor(installation)
    }
    if (shouldSuppress) {
      installation.renderer.cursorVisible = false
    } else if (wasSuppressed) {
      this.#restoreCursor(installation)
    }
    this.#ports.forceRender()
  }

  #ensureInstallation() {
    const renderer = this.#ports.terminal.renderer
    if (!renderer?.render) {
      this.#restoreInstalledRenderer()
      return null
    }
    if (
      this.#installation?.renderer === renderer
      && renderer.render === this.#installation.wrappedRender
    ) return this.#installation

    const shouldSuppress = this.#shouldSuppressCursor()
    this.#restoreInstalledRenderer()

    const originalRender = renderer.render
    let wrappedRender: TerminalRender
    wrappedRender = (wasmTerm, forceFullRedraw, viewportY, terminal, scrollbarOpacity) => {
      const current = this.#installation
      if (
        this.#disposed
        || current?.renderer !== renderer
        || current.wrappedRender !== wrappedRender
      ) {
        originalRender.call(renderer, wasmTerm, forceFullRedraw, viewportY, terminal, scrollbarOpacity)
        return
      }
      if (this.isRenderingSuspended) return

      const stableScrollbarOpacity = stableTerminalScrollbarOpacity(scrollbarOpacity)
      if (!this.#shouldSuppressCursor()) {
        originalRender.call(renderer, wasmTerm, forceFullRedraw, viewportY, terminal, stableScrollbarOpacity)
        return
      }

      renderer.cursorVisible = false
      originalRender.call(renderer, wasmTerm, true, viewportY, terminal, stableScrollbarOpacity)
      renderer.cursorVisible = false
    }
    this.#installation = { renderer, originalRender, wrappedRender, cursorRestore: null }
    renderer.render = wrappedRender
    if (shouldSuppress) {
      this.#captureCursor(this.#installation)
      renderer.cursorVisible = false
    }
    return this.#installation
  }

  #restoreInstalledRenderer() {
    const installation = this.#installation
    if (!installation) return
    this.#installation = null
    if (installation.renderer.render === installation.wrappedRender) {
      installation.renderer.render = installation.originalRender
    }
    this.#restoreCursor(installation)
  }

  #captureCursor(installation: RendererInstallation) {
    if (installation.cursorRestore) return
    installation.cursorRestore = {
      visible: installation.renderer.cursorVisible === undefined
        ? undefined
        : Boolean(installation.renderer.cursorVisible),
    }
  }

  #restoreCursor(installation: RendererInstallation) {
    if (!installation.cursorRestore) return
    installation.renderer.cursorVisible = installation.cursorRestore.visible ?? true
    installation.cursorRestore = null
  }
}
