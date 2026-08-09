import {
  collectTerminalLinkMatches,
  collectTerminalMultiLinePathLinkMatches,
  collectTerminalPathLinkMatches,
  parseExplicitTerminalUrlAtColumn,
  parseTerminalSearchAtColumn,
  parseTerminalUrlAtColumn,
  terminalLinkMatchRange,
  terminalTextColumnAtPixelOffset,
} from '@/lib/terminal-links'
import type {
  TerminalLinkHoverTarget,
  TerminalLinkMatch,
  TerminalPathOpenTarget,
} from '@/lib/terminal-links'
import type { TerminalLinkProvider } from '@/lib/terminal-engine'

export const TERMINAL_PATH_RESOLVE_CACHE_TTL_MS = 30_000
export const TERMINAL_OPEN_ACTIVATION_FENCE_MS = 250
const TERMINAL_EXACT_OPEN_CLICK_SLOP_PX = 4
const TERMINAL_OPEN_MODIFIER_KEYS = ['Control', 'Meta']

export type TerminalLinkOpenKind = 'url' | 'path' | 'search'

/**
 * Opaque identity of one owner's link handler set. Owners that hand the pool
 * stable wrapper functions cannot be compared by reference, so this token is
 * the only evidence that the resolver/opener behind those wrappers changed.
 */
export type TerminalLinkHandlersRevision = string

export interface TerminalLinkHandlerIdentities {
  onPathOpen?: unknown
  onPathResolve?: unknown
  onSearchOpen?: unknown
}

let nextTerminalLinkHandlersOwnerId = 0

/**
 * Derives the revision token of one owner's link handlers. The token is stable
 * while the three real handlers keep their identities, so a re-render that
 * changes nothing semantic - including StrictMode's double render - keeps the
 * previous token and invalidates no resolution.
 */
export function createTerminalLinkHandlersRevisionTracker() {
  nextTerminalLinkHandlersOwnerId += 1
  const ownerId = nextTerminalLinkHandlersOwnerId
  let revision = 0
  let current: TerminalLinkHandlerIdentities | null = null

  return {
    revisionFor(handlers: TerminalLinkHandlerIdentities): TerminalLinkHandlersRevision {
      if (
        !current
        || current.onPathOpen !== handlers.onPathOpen
        || current.onPathResolve !== handlers.onPathResolve
        || current.onSearchOpen !== handlers.onSearchOpen
      ) {
        revision += 1
        current = {
          onPathOpen: handlers.onPathOpen,
          onPathResolve: handlers.onPathResolve,
          onSearchOpen: handlers.onSearchOpen,
        }
      }
      return `${ownerId}:${revision}`
    },
  }
}

/**
 * Records, per agent, the exact revision its owner last committed. A commit must
 * reach the record before the owner's handlers become callable, but the record
 * can still be absent or in creation, so this latch carries the revision the
 * eventual record must adopt. Reading the latch at adoption time - instead of
 * trusting the revision a late attach captured - is what keeps a superseded
 * commit from overwriting the current one.
 *
 * A release therefore names the exact revision it captured and deletes only that
 * entry. A cleanup that runs after a newer commit - a destroy that awaited a
 * bootstrap, an unmount that raced a replacement owner, StrictMode's double
 * invoke - would otherwise drop the current owner's token and send the next late
 * attach back to the revision it captured before that commit.
 */
export function createTerminalLinkHandlersCommitLatch() {
  const committed = new Map<string, TerminalLinkHandlersRevision>()

  return {
    commit(agentId: string, revision: TerminalLinkHandlersRevision) {
      committed.set(agentId, revision)
    },
    committedRevision(
      agentId: string,
      attachedWith?: TerminalLinkHandlersRevision | null,
    ): TerminalLinkHandlersRevision | undefined {
      return committed.get(agentId) ?? attachedWith ?? undefined
    },
    release(agentId: string, revision: TerminalLinkHandlersRevision | null | undefined) {
      // A caller that captured no revision owns no entry, so it may not delete
      // one a later commit created.
      if (revision === undefined || revision === null) return false
      if (committed.get(agentId) !== revision) return false
      committed.delete(agentId)
      return true
    },
  }
}

export interface TerminalLinkCell {
  col: number
  row: number
}

export interface TerminalLinkLogicalLine {
  text: string
  col: number
  startRow: number
  cols: number
}

export interface TerminalLinkEventTarget {
  addEventListener: (type: string, listener: EventListener, options?: boolean | AddEventListenerOptions) => void
  removeEventListener: (type: string, listener: EventListener, options?: boolean | EventListenerOptions) => void
}

export interface TerminalLinkHostElement extends TerminalLinkEventTarget {
  classList: { toggle: (token: string, force?: boolean) => void }
  dataset: Record<string, string | undefined>
  title: string
  removeAttribute: (name: string) => void
  contains: (node: Node | null) => boolean
}

export interface TerminalLinkInteractionPorts {
  agentId: string
  hostEl: TerminalLinkHostElement
  windowTarget: TerminalLinkEventTarget
  isXterm: boolean
  registerLinkProvider: ((provider: TerminalLinkProvider) => { dispose: () => void }) | null
  now: () => number
  isMacPlatform: () => boolean
  language: () => string
  isMobileViewport: () => boolean
  isAttached: () => boolean
  attachmentGeneration: () => number
  isCurrentAttachment: (generation: number) => boolean
  cellFromEvent: (event: MouseEvent) => TerminalLinkCell | null
  cellMetrics: () => { width: number; height: number } | null
  elementFromPoint: (x: number, y: number) => Element | null
  logicalLineAtCell: (cell: TerminalLinkCell) => TerminalLinkLogicalLine | null
  logicalLineAtBufferRow: (bufferRow: number) => TerminalLinkLogicalLine | null
  previousLogicalLines: (beforeBufferRow: number) => string[]
  pathOpenHandler: () => ((agentId: string, target: TerminalPathOpenTarget) => void) | null
  pathResolveHandler: () => ((agentId: string, target: TerminalPathOpenTarget) => Promise<TerminalPathOpenTarget | null> | TerminalPathOpenTarget | null) | null
  searchOpenHandler: () => ((agentId: string, query: string) => void) | null
  openUrl: (url: string) => void
  clearSelection: () => void
  focusInput: () => void
}

/**
 * Identity of the interaction that produced a decision. `generation` is the
 * attachment identity; `revision` additionally changes when the link handlers
 * themselves are replaced, which a same-mount live-options refresh does without
 * an attachment transition.
 */
interface TerminalLinkInteractionFence {
  generation: number
  revision: number
}

interface PathResolveCacheEntry {
  fence: TerminalLinkInteractionFence
  resolvedAt: number
  target: TerminalPathOpenTarget | null
  promise?: Promise<TerminalPathOpenTarget | null>
}

interface TerminalExactOpenMouseDown {
  x: number
  y: number
  fence: TerminalLinkInteractionFence
  pathTargets: TerminalPathOpenTarget[]
}

export function isTerminalPathOpenClick(event: MouseEvent) {
  return event.button === 0 && (event.ctrlKey || event.metaKey)
}

function isTerminalOpenModifierEvent(
  event: Pick<MouseEvent, 'ctrlKey' | 'metaKey'>,
  isMacPlatform: boolean,
) {
  return isMacPlatform ? event.metaKey : event.ctrlKey
}

export function terminalOpenTargetTitle(
  kind: TerminalLinkOpenKind,
  platform: { isMacPlatform: boolean; language: string },
) {
  const modifier = platform.isMacPlatform ? 'Cmd' : 'Ctrl'
  if (platform.language.toLowerCase().startsWith('zh')) {
    if (kind === 'url') return `按住 ${modifier} 点击打开链接`
    if (kind === 'search') return `按住 ${modifier} 点击在工作区中搜索`
    return '点击打开文件或文件夹'
  }
  if (kind === 'url') return `${modifier}-click to open link`
  if (kind === 'search') return `${modifier}-click to search the workspace`
  return 'Click to open file or folder'
}

function terminalPathResolveCacheKey(target: TerminalPathOpenTarget) {
  return [
    target.path,
    target.lineNumber ?? '',
    target.column ?? '',
    target.endLineNumber ?? '',
    target.endColumn ?? '',
  ].join('\0')
}

function setTerminalLinkDecorations(
  link: { decorations?: { pointerCursor: boolean; underline: boolean } },
  options: { pointerCursor: boolean; underline: boolean },
) {
  if (!link.decorations) {
    link.decorations = options
    return
  }
  link.decorations.pointerCursor = options.pointerCursor
  link.decorations.underline = options.underline
}

function matchCoversColumn(match: TerminalLinkMatch, col: number) {
  return col >= match.startIndex && col < match.startIndex + match.length
}

/**
 * Owns one Terminal's link recognition, hover presentation, and open
 * activation. Every asynchronous path resolution commits only while the same
 * attachment generation, handler revision, hover identity, and undisposed owner
 * still hold, so a stale completion can neither decorate a parked host nor open
 * a target that belongs to a workspace the current handlers no longer own.
 */
export class TerminalLinkInteractionController {
  readonly #ports: TerminalLinkInteractionPorts
  readonly #pathResolveCache = new Map<string, PathResolveCacheEntry>()
  readonly #listenerRemovals: Array<() => void> = []
  #revision = 0
  #handlersRevision: TerminalLinkHandlersRevision | null = null
  #linkProviderDisposable: (() => void) | null = null
  #lastHoverEvent: MouseEvent | null = null
  #providerHoverTarget: TerminalLinkHoverTarget | null = null
  #openModifierActive = false
  #exactOpenMouseDown: TerminalExactOpenMouseDown | null = null
  #activationSuppressedUntil = 0
  #installed = false
  #disposed = false

  constructor(ports: TerminalLinkInteractionPorts) {
    this.#ports = ports
  }

  install() {
    if (this.#disposed || this.#installed) return false
    this.#installed = true
    this.#installLinkProvider()
    this.#listen(this.#ports.hostEl, 'mousedown', this.#handleExactOpenMouseDown as EventListener)
    this.#listen(this.#ports.hostEl, 'mouseup', this.#handleExactOpenMouseUp as EventListener)
    this.#listen(this.#ports.hostEl, 'click', this.#handleClick as EventListener)
    this.#listen(this.#ports.hostEl, 'mousemove', this.#handleHoverMove as EventListener)
    this.#listen(this.#ports.hostEl, 'mouseleave', this.#handleHoverLeave as EventListener)
    this.#listen(this.#ports.windowTarget, 'keydown', this.#handleModifierKey as EventListener)
    this.#listen(this.#ports.windowTarget, 'keyup', this.#handleModifierKey as EventListener)
    this.#listen(this.#ports.windowTarget, 'blur', this.#handleWindowBlur as EventListener, false)
    return true
  }

  /**
   * Drops every transient interaction fence. An attachment transition, a park,
   * or an injected fixture cut must not inherit a previous attachment's hover
   * decoration, pending exact-open mousedown, activation fence, or resolved
   * path cache.
   */
  reset() {
    this.#invalidateInteractionRevision()
    this.#activationSuppressedUntil = 0
  }

  /**
   * Declares that the host replaced the link handlers. This can happen without
   * an attachment transition, so only the revision separates a resolution that
   * the previous resolver produced from the workspace the new opener owns. The
   * activation fence intentionally survives: the click that was already
   * consumed must not open again through the new handlers.
   */
  notifyHandlersChanged() {
    this.#invalidateInteractionRevision()
  }

  /**
   * Adopts the owner's handler revision token. The owner may hand the pool
   * stable wrappers whose references never change, so this token is the only
   * evidence that the resolver/opener behind them was replaced. The first
   * adoption records the identity this owner attached with and invalidates
   * nothing; every later change does.
   */
  adoptHandlersRevision(revision: TerminalLinkHandlersRevision | null | undefined) {
    if (revision === undefined || revision === null || revision === this.#handlersRevision) return false
    const known = this.#handlersRevision !== null
    this.#handlersRevision = revision
    if (!known) return false
    this.notifyHandlersChanged()
    return true
  }

  #invalidateInteractionRevision() {
    this.#revision += 1
    this.#clearHoverState()
    this.#exactOpenMouseDown = null
    this.#pathResolveCache.clear()
  }

  #clearHoverState() {
    this.#openModifierActive = false
    this.#lastHoverEvent = null
    this.#providerHoverTarget = null
    this.#setHoverTarget(null)
  }

  dispose() {
    if (this.#disposed) return false
    this.#disposed = true
    while (this.#listenerRemovals.length > 0) {
      this.#listenerRemovals.pop()?.()
    }
    this.#linkProviderDisposable?.()
    this.#linkProviderDisposable = null
    this.#lastHoverEvent = null
    this.#providerHoverTarget = null
    this.#exactOpenMouseDown = null
    this.#pathResolveCache.clear()
    return true
  }

  get isActivationSuppressed() {
    return this.#ports.now() < this.#activationSuppressedUntil
  }

  suppressActivation() {
    this.#activationSuppressedUntil = this.#ports.now() + TERMINAL_OPEN_ACTIVATION_FENCE_MS
  }

  urlAtCell(cell: TerminalLinkCell) {
    const logicalLine = this.#ports.logicalLineAtCell(cell)
    return logicalLine ? parseTerminalUrlAtColumn(logicalLine.text, logicalLine.col) : null
  }

  urlAtEvent(event: MouseEvent) {
    const cell = this.#ports.cellFromEvent(event)
    if (cell) {
      const url = this.urlAtCell(cell)
      if (url) return url
    }

    const domLine = this.#readDomLineAtEvent(event)
    return domLine ? parseTerminalUrlAtColumn(domLine.text, domLine.col) : null
  }

  #pathLinksAtCell(cell: TerminalLinkCell) {
    const logicalLine = this.#ports.logicalLineAtCell(cell)
    if (!logicalLine) return []
    // URL-shaped text is owned by the URL interaction. Treating its path
    // portion as a workspace path makes a plain click start file resolution and
    // briefly suppresses the modifier-click that should open the URL.
    if (parseExplicitTerminalUrlAtColumn(logicalLine.text, logicalLine.col)) return []
    const directLinks = collectTerminalPathLinkMatches(logicalLine.text)
      .filter(match => matchCoversColumn(match, logicalLine.col))
    if (directLinks.length > 0) return directLinks
    return collectTerminalMultiLinePathLinkMatches(
      logicalLine.text,
      this.#ports.previousLogicalLines(logicalLine.startRow),
    ).filter(match => matchCoversColumn(match, logicalLine.col))
  }

  pathLinkAtCell(cell: TerminalLinkCell) {
    return this.#pathLinksAtCell(cell)[0] ?? null
  }

  #pathLinksAtEvent(event: MouseEvent) {
    const cell = this.#ports.cellFromEvent(event)
    if (cell) {
      const pathLinks = this.#pathLinksAtCell(cell)
      if (pathLinks.length > 0) return pathLinks
    }

    const domLine = this.#readDomLineAtEvent(event)
    if (!domLine || parseExplicitTerminalUrlAtColumn(domLine.text, domLine.col)) return []
    return collectTerminalPathLinkMatches(domLine.text)
      .filter(match => matchCoversColumn(match, domLine.col))
  }

  pathLinkAtEvent(event: MouseEvent) {
    return this.#pathLinksAtEvent(event)[0] ?? null
  }

  resolvedPathLinkAtEvent(event: MouseEvent) {
    for (const pathLink of this.#pathLinksAtEvent(event)) {
      const cached = this.#cachedPathLink(pathLink)
      if (cached) return cached
    }
    return null
  }

  resolvedPathTargetAtEvent(event: MouseEvent) {
    return this.resolvedPathLinkAtEvent(event)?.pathTarget ?? null
  }

  #searchAtEvent(event: MouseEvent) {
    if (this.urlAtEvent(event)) return null
    if (this.#ports.pathOpenHandler() && this.pathLinkAtEvent(event)) return null
    const cell = this.#ports.cellFromEvent(event)
    if (cell) {
      const logicalLine = this.#ports.logicalLineAtCell(cell)
      const query = logicalLine ? parseTerminalSearchAtColumn(logicalLine.text, logicalLine.col) : null
      if (query) return query
    }

    const domLine = this.#readDomLineAtEvent(event)
    return domLine ? parseTerminalSearchAtColumn(domLine.text, domLine.col) : null
  }

  #openTargetKindAtEvent(
    event: MouseEvent,
    modifierActive = this.#isOpenModifierActive(event),
  ): TerminalLinkOpenKind | null {
    if (this.#ports.pathOpenHandler() && this.resolvedPathTargetAtEvent(event)) return 'path'
    if (!modifierActive) return null
    if (this.urlAtEvent(event)) return 'url'
    if (this.#ports.searchOpenHandler() && this.#searchAtEvent(event)) return 'search'
    return null
  }

  async resolvePathTarget(target: TerminalPathOpenTarget) {
    // The fence is the identity of this request. Capture and validate it before
    // any decision, so a disposed owner or a superseded attachment cannot pass
    // a target through the resolver-free and global-root shortcuts either.
    const fence = this.#currentFence()
    if (!this.#isCurrentFence(fence)) return null

    const resolveHandler = this.#ports.pathResolveHandler()
    if (!resolveHandler) return target
    if (target.globalRoot) return target

    const cacheKey = terminalPathResolveCacheKey(target)
    const cached = this.#pathResolveCache.get(cacheKey)
    if (
      cached
      && this.#isCurrentFence(cached.fence)
      && this.#ports.now() - cached.resolvedAt <= TERMINAL_PATH_RESOLVE_CACHE_TTL_MS
    ) {
      if (!cached.promise) return cached.target
      return await this.#settlePathResolve(cacheKey, cached.promise, fence)
    }

    // A resolver that throws synchronously is a failed resolution, not a
    // rejection the caller must handle.
    const promise = Promise.resolve()
      .then(() => resolveHandler(this.#ports.agentId, target))
      .catch(() => null)
    this.#pathResolveCache.set(cacheKey, {
      fence,
      resolvedAt: this.#ports.now(),
      target: null,
      promise,
    })
    return await this.#settlePathResolve(cacheKey, promise, fence)
  }

  async #resolveLinkMatches(matches: TerminalLinkMatch[]) {
    if (!this.#ports.pathResolveHandler()) return matches

    const resolved = await Promise.all(matches.map(async match => {
      if (match.kind !== 'path' || !match.pathTarget) return match
      const resolvedTarget = await this.resolvePathTarget(match.pathTarget)
      return resolvedTarget ? { ...match, pathTarget: resolvedTarget } : null
    }))
    const available = resolved.filter((match): match is TerminalLinkMatch => Boolean(match))
    const preferred: TerminalLinkMatch[] = []
    for (const match of [...available].sort((a, b) => a.length - b.length || a.startIndex - b.startIndex)) {
      if (
        match.kind === 'path'
        && preferred.some(existing => (
          existing.kind === 'path'
          && match.startIndex < existing.startIndex + existing.length
          && existing.startIndex < match.startIndex + match.length
        ))
      ) continue
      preferred.push(match)
    }
    return preferred.sort((a, b) => a.startIndex - b.startIndex)
  }

  async #resolvePathLinkAtEvent(event: MouseEvent) {
    if (!this.#ports.pathOpenHandler()) return null
    for (const pathLink of this.#pathLinksAtEvent(event)) {
      if (!pathLink.pathTarget) continue
      const resolvedTarget = await this.resolvePathTarget(pathLink.pathTarget)
      if (resolvedTarget) return { ...pathLink, pathTarget: resolvedTarget }
    }
    return null
  }

  #refreshHoverTarget(modifierActive?: boolean) {
    if (!this.#ports.isAttached() || this.#ports.isMobileViewport()) {
      this.#setHoverTarget(null)
      return
    }

    const providerTarget = this.#providerHoverTarget
    const active = modifierActive ?? this.#openModifierActive
    if (providerTarget) {
      this.#setHoverTarget(providerTarget.kind === 'path' || active ? providerTarget.kind : null)
      return
    }

    const hoverEvent = this.#lastHoverEvent
    if (!hoverEvent) {
      this.#setHoverTarget(null)
      return
    }

    this.#setHoverTarget(this.#openTargetKindAtEvent(hoverEvent, active))
  }

  /**
   * Opens the exact target under a completed click. Returns true when this
   * interaction claimed the event so the caller does not also treat it as a
   * selection or focus gesture.
   */
  activateOpenTargetAtEvent(event: MouseEvent) {
    const modifierActive = this.#isOpenModifierActive(event)
    const url = event.button === 0 && modifierActive ? this.urlAtEvent(event) : null
    if (url) {
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      this.#ports.openUrl(url)
      this.suppressActivation()
      return true
    }

    const searchOpenHandler = this.#ports.searchOpenHandler()
    const searchQuery = event.button === 0 && modifierActive && searchOpenHandler
      ? this.#searchAtEvent(event)
      : null
    if (searchQuery) {
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      this.#ports.clearSelection()
      searchOpenHandler?.(this.#ports.agentId, searchQuery)
      this.suppressActivation()
      return true
    }

    if (this.#ports.pathOpenHandler() && event.button === 0) {
      const pathTarget = this.resolvedPathTargetAtEvent(event)
      if (pathTarget) {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
        this.#ports.clearSelection()
        const fence = this.#currentFence()
        void this.resolvePathTarget(pathTarget).then(resolvedTarget => {
          if (!this.#isCurrentFence(fence)) return
          if (!resolvedTarget) {
            this.#ports.focusInput()
            return
          }
          this.#ports.pathOpenHandler()?.(this.#ports.agentId, resolvedTarget)
        })
        this.suppressActivation()
        return true
      }
    }

    return false
  }

  #currentFence(): TerminalLinkInteractionFence {
    return { generation: this.#ports.attachmentGeneration(), revision: this.#revision }
  }

  #isCurrentFence(fence: TerminalLinkInteractionFence) {
    if (this.#disposed || fence.revision !== this.#revision) return false
    return this.#ports.isCurrentAttachment(fence.generation)
  }

  #isOpenModifierActive(event: Pick<MouseEvent, 'ctrlKey' | 'metaKey'>) {
    return isTerminalOpenModifierEvent(event, this.#ports.isMacPlatform()) || this.#openModifierActive
  }

  async #settlePathResolve(
    cacheKey: string,
    promise: Promise<TerminalPathOpenTarget | null>,
    fence: TerminalLinkInteractionFence,
  ) {
    const resolved = await promise
    if (!this.#isCurrentFence(fence)) return null

    // Only the resolution the cache is still waiting for may commit. A promise
    // that another request already replaced describes a candidate this owner no
    // longer tracks, so it is not evidence for this caller either.
    const current = this.#pathResolveCache.get(cacheKey)
    if (current?.promise !== promise) return null
    this.#pathResolveCache.set(cacheKey, {
      fence,
      resolvedAt: this.#ports.now(),
      target: resolved,
    })
    return resolved
  }

  #cachedPathLink(match: TerminalLinkMatch) {
    if (!this.#ports.pathResolveHandler() || match.kind !== 'path' || !match.pathTarget) return match

    const cached = this.#pathResolveCache.get(terminalPathResolveCacheKey(match.pathTarget))
    if (
      !cached
      || cached.promise
      || !this.#isCurrentFence(cached.fence)
      || this.#ports.now() - cached.resolvedAt > TERMINAL_PATH_RESOLVE_CACHE_TTL_MS
    ) {
      return null
    }
    return cached.target ? { ...match, pathTarget: cached.target } : null
  }

  #readDomLineAtEvent(event: MouseEvent) {
    const target = this.#ports.elementFromPoint(event.clientX, event.clientY)
    const row = target?.closest<HTMLElement>('.xterm-rows > div') ?? null
    if (!row || !this.#ports.hostEl.contains(row)) return null

    const metrics = this.#ports.cellMetrics()
    const rowRect = row.getBoundingClientRect()
    if (!metrics || metrics.width <= 0 || rowRect.width <= 0) return null

    const text = (row.textContent || '').trimEnd()
    if (!text) return null

    const col = terminalTextColumnAtPixelOffset(event.clientX - rowRect.left, metrics.width, text.length)
    if (col === null) return null
    return { text, col }
  }

  #setHoverTarget(kind: TerminalLinkOpenKind | null) {
    const hostEl = this.#ports.hostEl
    hostEl.classList.toggle('terminal-open-target-hover', kind !== null)
    hostEl.classList.toggle('terminal-open-target-url', kind === 'url')
    hostEl.classList.toggle('terminal-open-target-path', kind === 'path')
    hostEl.classList.toggle('terminal-open-target-search', kind === 'search')
    if (kind) {
      hostEl.dataset.terminalOpenTarget = kind
      hostEl.title = terminalOpenTargetTitle(kind, {
        isMacPlatform: this.#ports.isMacPlatform(),
        language: this.#ports.language(),
      })
    } else {
      delete hostEl.dataset.terminalOpenTarget
      hostEl.removeAttribute('title')
    }
  }

  #listen(
    target: TerminalLinkEventTarget,
    type: string,
    listener: EventListener,
    capture = true,
  ) {
    target.addEventListener(type, listener, capture)
    this.#listenerRemovals.push(() => target.removeEventListener(type, listener, capture))
  }

  #handleHoverMove = (event: MouseEvent) => {
    if (!this.#ports.isAttached()) {
      this.#clearHoverState()
      return
    }
    const fence = this.#currentFence()
    this.#lastHoverEvent = event
    if (!this.#openTargetKindAtEvent(event)) {
      this.#providerHoverTarget = null
      this.#setHoverTarget(null)
    }
    this.#refreshHoverTarget()
    void this.#resolvePathLinkAtEvent(event).then(pathLink => {
      if (!pathLink) return
      if (this.#lastHoverEvent !== event || !this.#isCurrentFence(fence)) return
      this.#providerHoverTarget = {
        kind: 'path',
        text: pathLink.text,
        ...(pathLink.pathTarget ? { pathTarget: pathLink.pathTarget } : {}),
      }
      this.#setHoverTarget('path')
    })
  }

  #handleHoverLeave = () => {
    this.#clearHoverState()
  }

  #handleWindowBlur = () => {
    this.#clearHoverState()
  }

  #handleModifierKey = (event: KeyboardEvent) => {
    if (!this.#ports.isAttached()) {
      this.#clearHoverState()
      return
    }
    if (event.type === 'keydown' && TERMINAL_OPEN_MODIFIER_KEYS.includes(event.key)) {
      this.#openModifierActive = true
    } else {
      this.#openModifierActive = isTerminalOpenModifierEvent(event, this.#ports.isMacPlatform())
    }
    if (!this.#lastHoverEvent) return
    if (!TERMINAL_OPEN_MODIFIER_KEYS.includes(event.key) && !this.#openModifierActive) return
    this.#refreshHoverTarget(this.#openModifierActive)
  }

  #handleExactOpenMouseDown = (event: MouseEvent) => {
    this.#exactOpenMouseDown = null
    if (
      this.#ports.isMobileViewport()
      || event.button !== 0
      || event.ctrlKey
      || event.metaKey
      || event.altKey
    ) return
    const pathTargets = this.#ports.pathOpenHandler()
      ? this.#pathLinksAtEvent(event).flatMap(link => link.pathTarget ? [link.pathTarget] : [])
      : []
    if (pathTargets.length === 0) return
    // Do not intercept mousedown: xterm needs it to start text selection when
    // the user drags across a path. The later mouseup/click path decides
    // whether this was a small click that should open the file.
    this.#exactOpenMouseDown = {
      x: event.clientX,
      y: event.clientY,
      fence: this.#currentFence(),
      pathTargets,
    }
  }

  #handleExactOpenMouseUp = (event: MouseEvent) => {
    if (this.#ports.isMobileViewport() || event.button !== 0) return
    if (this.isActivationSuppressed) {
      this.#exactOpenMouseDown = null
      return
    }
    if (this.#isOpenModifierActive(event)) {
      const url = this.urlAtEvent(event)
      if (url) {
        // xterm owns a document-level mouseup listener that terminates its
        // selection gesture. Let this mouseup bubble to it; the following
        // click is still suppressed so the target opens only once.
        this.#claimOpenMouseUp(event)
        this.#ports.openUrl(url)
        this.suppressActivation()
        return
      }
      const searchOpenHandler = this.#ports.searchOpenHandler()
      const searchQuery = searchOpenHandler ? this.#searchAtEvent(event) : null
      if (searchQuery) {
        this.#claimOpenMouseUp(event)
        this.#ports.clearSelection()
        searchOpenHandler?.(this.#ports.agentId, searchQuery)
        this.suppressActivation()
        return
      }
    }

    const mouseDown = this.#exactOpenMouseDown
    this.#exactOpenMouseDown = null
    if (!mouseDown) return
    if (!this.#isCurrentFence(mouseDown.fence)) return
    if (
      Math.hypot(event.clientX - mouseDown.x, event.clientY - mouseDown.y)
      > TERMINAL_EXACT_OPEN_CLICK_SLOP_PX
    ) {
      this.suppressActivation()
      return
    }
    if (this.activateOpenTargetAtEvent(event)) return

    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
    this.#ports.clearSelection()
    this.suppressActivation()
    void (async () => {
      for (const pathTarget of mouseDown.pathTargets) {
        const resolvedTarget = await this.resolvePathTarget(pathTarget)
        if (!this.#isCurrentFence(mouseDown.fence)) return
        if (!resolvedTarget) continue
        this.#ports.pathOpenHandler()?.(this.#ports.agentId, resolvedTarget)
        this.suppressActivation()
        return
      }
      this.#ports.focusInput()
    })()
  }

  #claimOpenMouseUp(event: MouseEvent) {
    event.preventDefault()
    if (this.#ports.isXterm) return
    event.stopPropagation()
    event.stopImmediatePropagation()
  }

  #handleClick = (event: MouseEvent) => {
    if (this.#ports.isMobileViewport()) return

    if (this.isActivationSuppressed) {
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      return
    }

    if (this.activateOpenTargetAtEvent(event)) return

    this.#ports.focusInput()
  }

  #installLinkProvider() {
    const registerLinkProvider = this.#ports.registerLinkProvider
    if (!registerLinkProvider) return

    const provider: TerminalLinkProvider = {
      provideLinks: (bufferLineNumber, callback) => {
        if (this.#disposed) {
          callback(undefined)
          return
        }
        const fence = this.#currentFence()

        const logicalLine = this.#ports.logicalLineAtBufferRow(bufferLineNumber - 1)
        if (!logicalLine?.text) {
          callback(undefined)
          return
        }

        const pathOpenHandler = this.#ports.pathOpenHandler()
        const matches = collectTerminalLinkMatches(
          logicalLine.text,
          Boolean(pathOpenHandler),
          Boolean(this.#ports.searchOpenHandler()),
        )
        if (pathOpenHandler) {
          const previousLogicalLines = this.#ports.previousLogicalLines(logicalLine.startRow)
          for (const multiLineMatch of collectTerminalMultiLinePathLinkMatches(
            logicalLine.text,
            previousLogicalLines,
          )) {
            const overlapsHigherPriority = matches.some(match => (
              match.kind !== 'search'
              &&
              multiLineMatch.startIndex < match.startIndex + match.length
              && match.startIndex < multiLineMatch.startIndex + multiLineMatch.length
            ))
            if (overlapsHigherPriority) continue
            for (let index = matches.length - 1; index >= 0; index -= 1) {
              const match = matches[index]
              if (
                match?.kind === 'search'
                && multiLineMatch.startIndex < match.startIndex + match.length
                && match.startIndex < multiLineMatch.startIndex + multiLineMatch.length
              ) {
                matches.splice(index, 1)
              }
            }
            matches.push(multiLineMatch)
          }
          matches.sort((a, b) => a.startIndex - b.startIndex)
        }
        if (matches.length === 0) {
          callback(undefined)
          return
        }

        void (async () => {
          const resolvedMatches = await this.#resolveLinkMatches(matches)
          if (!this.#isCurrentFence(fence)) {
            callback(undefined)
            return
          }
          if (resolvedMatches.length === 0) {
            callback(undefined)
            return
          }

          callback(resolvedMatches.map(match => this.#createLink(match, logicalLine, fence)))
        })()
      },
    }

    const disposable = registerLinkProvider(provider)
    this.#linkProviderDisposable = () => disposable.dispose()
  }

  #createLink(
    match: TerminalLinkMatch,
    logicalLine: TerminalLinkLogicalLine,
    fence: TerminalLinkInteractionFence,
  ) {
    const pathDirectOpen = match.kind === 'path' && Boolean(match.pathTarget && this.#ports.pathOpenHandler())
    const link = {
      range: terminalLinkMatchRange(match, logicalLine),
      text: match.text,
      decorations: {
        pointerCursor: pathDirectOpen,
        // xterm snapshots the initial decoration state before invoking
        // link.hover, then installs the live decoration setters. Keep
        // URLs underlined in that initial state so the first hover is
        // visibly recognized; the modifier still gates activation and
        // the pointer cursor.
        underline: pathDirectOpen || match.kind === 'url',
      },
      activate: (event: MouseEvent) => {
        if (event.button !== 0) return
        if (this.isActivationSuppressed) return
        if (!this.#isCurrentFence(fence)) return
        const modifierActive = this.#isOpenModifierActive(event)
        if (match.kind === 'url' && this.urlAtEvent(event) !== match.text) return
        if (
          match.kind === 'path'
          && !this.#pathLinksAtEvent(event).some(pathLink => pathLink.text === match.text)
        ) return
        if (match.kind === 'search' && this.#searchAtEvent(event) !== match.text) return
        if (match.kind === 'url' && !modifierActive) return
        if (match.kind === 'search' && !modifierActive) return
        if (match.kind === 'path' && !pathDirectOpen) return

        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
        if (match.kind === 'url') {
          this.#ports.openUrl(match.text)
        } else if (match.kind === 'search') {
          this.#ports.searchOpenHandler()?.(this.#ports.agentId, match.text)
        } else if (match.pathTarget) {
          this.#ports.pathOpenHandler()?.(this.#ports.agentId, match.pathTarget)
        }
        this.suppressActivation()
      },
      hover: (event: MouseEvent) => {
        if (!this.#ports.isAttached() || this.#ports.isMobileViewport()) return
        if (!this.#isCurrentFence(fence)) return
        this.#providerHoverTarget = {
          kind: match.kind,
          text: match.text,
          ...(match.pathTarget ? { pathTarget: match.pathTarget } : {}),
        }
        this.#lastHoverEvent = event
        const active = pathDirectOpen || this.#isOpenModifierActive(event)
        setTerminalLinkDecorations(link, {
          pointerCursor: active,
          underline: pathDirectOpen || match.kind === 'url' || active,
        })
        this.#refreshHoverTarget(active)
      },
      leave: () => {
        if (this.#providerHoverTarget?.text === match.text) {
          this.#providerHoverTarget = null
        }
        setTerminalLinkDecorations(link, {
          pointerCursor: pathDirectOpen,
          underline: pathDirectOpen || match.kind === 'url',
        })
        this.#clearHoverState()
      },
      dispose: () => {
        if (this.#providerHoverTarget?.text === match.text) {
          this.#providerHoverTarget = null
        }
      },
    }
    return link
  }
}
