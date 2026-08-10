import assert from 'node:assert/strict'
import test from 'node:test'
import { TerminalSessionInteractionController } from '../src/lib/terminal-session-interaction'

class FakeTarget {
  readonly listeners = new Map<string, Set<EventListener>>()

  addEventListener(type: string, listener: EventListener) {
    const entries = this.listeners.get(type) ?? new Set<EventListener>()
    entries.add(listener)
    this.listeners.set(type, entries)
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener)
  }

  listenerCount() {
    return [...this.listeners.values()].reduce((count, entries) => count + entries.size, 0)
  }
}

test('interaction owner installs and disposes its exact DOM listener set', () => {
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  const previousNavigator = globalThis.navigator
  const fakeWindow = new FakeTarget() as unknown as Window
  const fakeDocument = new FakeTarget() as unknown as Document
  Object.assign(fakeDocument, {
    documentElement: { lang: 'en' },
    body: {},
  })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument })
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { platform: 'MacIntel', language: 'en' },
  })

  const host = new FakeTarget() as FakeTarget & {
    contains: () => boolean
    querySelector: () => null
  }
  host.contains = () => false
  host.querySelector = () => null
  let linkInstalls = 0
  let linkDisposals = 0
  let selectionInstalls = 0
  let selectionDisposals = 0
  const link = {
    install: () => { linkInstalls += 1 },
    dispose: () => { linkDisposals += 1 },
    reset: () => {},
  }
  const selection = {
    install: () => { selectionInstalls += 1 },
    dispose: () => { selectionDisposals += 1 },
    clear: () => {},
    clearTransient: () => {},
    contextMenuSelection: '',
    cachedSelection: '',
    lastNonEmptySelection: '',
  }
  const controller = new TerminalSessionInteractionController({
    agentId: 'agent-a',
    hostEl: host as unknown as HTMLDivElement,
    terminal: {} as never,
    isXterm: true,
    fontFamily: 'monospace',
    selection: selection as never,
    rendererEffects: { isImeComposing: false } as never,
    link: {
      controller: link as never,
      pathOpenHandler: () => null,
      farmingUrlOpenHandler: () => null,
    },
    viewport: {
      pageScroll: () => {},
      onScrollIntent: () => {},
      lineHeight: () => 16,
      viewportY: () => 0,
      scrollToViewportY: () => {},
      onTouchViewportChanged: () => {},
    },
    input: { disabled: () => false, send: () => true, clear: () => {} },
    isDisposed: () => false,
    isAttached: () => true,
    focusInput: () => true,
    focusRevision: () => 0,
    mayRestoreFocus: () => true,
    attachmentOperation: () => ({ generation: 1, revision: 1 }),
    isCurrentAttachmentOperation: () => true,
    readFontSize: () => 14,
  })

  try {
    assert.equal(controller.install(), true)
    assert.equal(controller.install(), false)
    assert.equal(selectionInstalls, 1)
    assert.equal(linkInstalls, 1)
    assert.ok(host.listenerCount() > 0)
    assert.ok((fakeWindow as unknown as FakeTarget).listenerCount() > 0)
    assert.ok((fakeDocument as unknown as FakeTarget).listenerCount() > 0)

    assert.equal(controller.dispose(), true)
    assert.equal(controller.dispose(), false)
    assert.equal(selectionDisposals, 1)
    assert.equal(linkDisposals, 1)
    assert.equal(host.listenerCount(), 0)
    assert.equal((fakeWindow as unknown as FakeTarget).listenerCount(), 0)
    assert.equal((fakeDocument as unknown as FakeTarget).listenerCount(), 0)
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
    Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument })
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previousNavigator })
  }
})
