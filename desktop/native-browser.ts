import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  session as electronSession,
  WebContentsView,
  type BrowserWindow,
  type DownloadItem,
  type Event,
  type Session,
  type WebContents,
} from 'electron'
import type {
  DesktopNativeBrowserBounds,
  DesktopNativeBrowserCommand,
  DesktopNativeBrowserEvent,
} from '../shared/desktop-contract.js'

const MAX_NATIVE_BROWSER_DIMENSION = 8_192
const MAX_NATIVE_BROWSER_SCRIPT = 100_000
const MAX_NATIVE_BROWSER_SCREENSHOT_BYTES = 32 * 1024 * 1024
const MAX_NATIVE_BROWSER_TEXT = 50_000
const MAX_NATIVE_BROWSER_FILE_BYTES = 8 * 1024 * 1024
const MAX_NATIVE_BROWSER_DOWNLOAD_TIMEOUT_MS = 120_000
const MIN_NATIVE_BROWSER_ZOOM = 0.5
const MAX_NATIVE_BROWSER_ZOOM = 3
const NATIVE_BROWSER_ZOOM_STEP = 0.1

type NativeBrowserTab = {
  closing: boolean
  controlEpoch: number
  controlOwner: 'agent' | 'user'
  generation: number
  id: string
  interactionShield: WebContentsView
  loading: boolean
  mounted: boolean
  pendingControl: {
    controlEpoch: number
    owner: 'agent' | 'user'
  } | null
  pendingErrors: string[]
  resourceId: string
  sessionId: string
  view: WebContentsView
}

type NativeBrowserSession = {
  activeTabId: string
  closing: boolean
  id: string
  partition: string
  tabs: Map<string, NativeBrowserTab>
}

export interface DesktopNativeBrowserControllerOptions {
  adapterId?: string
  getWindow: () => BrowserWindow | null
  onEvent: (event: DesktopNativeBrowserEvent) => void
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function text(value: unknown, maximum = 8_192): string {
  return String(value || '').trim().slice(0, maximum)
}

function positiveInteger(value: unknown, maximum: number) {
  const number = Number(value)
  return Number.isFinite(number)
    ? Math.max(0, Math.min(maximum, Math.round(number)))
    : 0
}

function nativeBrowserError(
  message: string,
  code = 'BROWSER_DESKTOP_COMMAND_FAILED',
  uncertain = false,
) {
  const status = code === 'BROWSER_DESKTOP_ADAPTER_UNAVAILABLE'
    ? 503
    : code === 'BROWSER_DESKTOP_COMMAND_TIMEOUT'
      ? 504
      : code.startsWith('BROWSER_INVALID') || code === 'BROWSER_UNSAFE_SCHEME'
        ? 400
        : (
          code.includes('STALE')
          || code.includes('NOT_RUNNING')
          || code.includes('TAB_UNAVAILABLE')
          || code.includes('CONTROL')
          || code.includes('PROFILE_IN_USE')
          || code.includes('UNSUPPORTED')
        )
          ? 409
          : 500
  return Object.assign(new Error(message), { code, status, ...(uncertain ? { uncertain: true } : {}) })
}

function boundedTimeout(value: unknown, fallback = 30_000) {
  const requested = Number(value)
  if (!Number.isFinite(requested)) return fallback
  return Math.max(100, Math.min(MAX_NATIVE_BROWSER_DOWNLOAD_TIMEOUT_MS, Math.round(requested)))
}

function nativeBrowserZoomFactor(value: unknown): number {
  const factor = Number(value)
  if (!Number.isFinite(factor)) {
    throw nativeBrowserError('Desktop Browser zoom factor is invalid', 'BROWSER_INVALID_REQUEST')
  }
  return Math.max(MIN_NATIVE_BROWSER_ZOOM, Math.min(MAX_NATIVE_BROWSER_ZOOM, factor))
}

function nativeBrowserControlEpoch(value: unknown, label = 'Desktop Browser control epoch'): number {
  const epoch = Number(value)
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw nativeBrowserError(`${label} is invalid`, 'BROWSER_DESKTOP_COMMAND_INVALID')
  }
  return epoch
}

function nativeBrowserPartition(sessionId: string): string {
  return `persist:farming-browser-${crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 32)}`
}

function nativeCookieSameSite(value: unknown) {
  const normalized = text(value, 32).toLowerCase()
  if (!normalized) return undefined
  if (normalized === 'strict') return 'strict' as const
  if (normalized === 'lax') return 'lax' as const
  if (normalized === 'none' || normalized === 'no_restriction') return 'no_restriction' as const
  if (normalized === 'unspecified') return 'unspecified' as const
  throw nativeBrowserError('Desktop Browser cookie sameSite is invalid', 'BROWSER_INVALID_REQUEST')
}

export function normalizeNativeBrowserUrl(value: unknown): string {
  const input = text(value)
  if (!input || input === 'about:blank') return 'about:blank'
  let candidate = input
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(candidate)) {
    const authority = candidate.split(/[/?#]/, 1)[0] || ''
    const hostname = authority.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase()
    const local = hostname === 'localhost'
      || hostname.endsWith('.localhost')
      || !hostname.includes('.')
      || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)
      || authority.startsWith('[')
    candidate = `${local ? 'http' : 'https'}://${candidate}`
  }
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw nativeBrowserError('Invalid Browser URL', 'BROWSER_INVALID_URL')
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw nativeBrowserError(
      'Desktop Browser navigation supports only http, https, and about:blank URLs',
      'BROWSER_UNSAFE_SCHEME',
    )
  }
  return url.href
}

export function clampNativeBrowserBounds(value: Partial<DesktopNativeBrowserBounds>): DesktopNativeBrowserBounds {
  return {
    height: positiveInteger(value.height, MAX_NATIVE_BROWSER_DIMENSION),
    width: positiveInteger(value.width, MAX_NATIVE_BROWSER_DIMENSION),
    x: positiveInteger(value.x, MAX_NATIVE_BROWSER_DIMENSION * 2),
    y: positiveInteger(value.y, MAX_NATIVE_BROWSER_DIMENSION * 2),
  }
}

function tabSummary(tab: NativeBrowserTab, active: boolean) {
  const contents = tab.view.webContents
  return {
    active,
    controlEpoch: tab.controlEpoch,
    controlOwner: tab.controlOwner,
    tabId: tab.id,
    title: contents.getTitle().slice(0, 512),
    type: 'page',
    url: contents.getURL() || 'about:blank',
  }
}

export function nativeBrowserDomScript(operation: string, input: Record<string, unknown>) {
  const serializedOperation = JSON.stringify(operation).replace(/</g, '\\u003c')
  const serialized = JSON.stringify(input).replace(/</g, '\\u003c')
  return `(() => {
    const operation = ${serializedOperation};
    const input = ${serialized};
    const cap = (value, max = ${MAX_NATIVE_BROWSER_TEXT}) => String(value ?? '').slice(0, max);
    const refSelector = ref => ref ? '[data-farming-native-browser-ref="' + CSS.escape(String(ref)) + '"]' : '';
    const selector = input.selector ? String(input.selector) : refSelector(input.ref);
    const node = () => {
      if (!selector) throw new Error('Browser element reference or selector is required');
      const found = document.querySelector(selector);
      if (!found) throw new Error('Browser element is unavailable');
      return found;
    };
    const inputValue = element => ('value' in element ? String(element.value ?? '') : String(element.textContent ?? ''));
    const trigger = (element, type) => element.dispatchEvent(new Event(type, { bubbles: true }));
    const setText = (element, value, append) => {
      const text = String(value ?? '');
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        element.focus();
        element.value = append ? element.value + text : text;
      } else if (element instanceof HTMLElement && element.isContentEditable) {
        element.focus();
        element.textContent = append ? (element.textContent || '') + text : text;
      } else {
        throw new Error('Browser element does not accept text input');
      }
      trigger(element, 'input');
      trigger(element, 'change');
      return { ok: true };
    };
    const perform = (kind, target) => {
      if (kind === 'click') { target.click(); return { ok: true }; }
      if (kind === 'dblclick') { target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, view: window })); return { ok: true }; }
      if (kind === 'hover') { target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, view: window })); return { ok: true }; }
      if (kind === 'focus') { target.focus(); return { ok: true }; }
      if (kind === 'check' || kind === 'uncheck') {
        if (!(target instanceof HTMLInputElement) || !['checkbox', 'radio'].includes(target.type)) throw new Error('Browser element is not checkable');
        target.checked = kind === 'check'; trigger(target, 'input'); trigger(target, 'change'); return { ok: true };
      }
      if (kind === 'scrollintoview') { target.scrollIntoView({ block: 'center', inline: 'nearest' }); return { ok: true }; }
      if (kind === 'highlight') {
        const previous = target.style.outline;
        target.style.outline = '2px solid #e08b00';
        setTimeout(() => { target.style.outline = previous; }, 1_500);
        return { ok: true };
      }
      throw new Error('Unsupported Browser element action: ' + kind);
    };
    if (operation === 'snapshot') {
      const elements = [];
      const nodes = Array.from(document.querySelectorAll('a,button,input,textarea,select,[contenteditable="true"],[role="button"],[role="link"]')).slice(0, 500);
      nodes.forEach((element, index) => {
        const ref = 'e' + (index + 1);
        element.setAttribute('data-farming-native-browser-ref', ref);
        const role = element.getAttribute('role') || element.tagName.toLowerCase();
        const name = (element.getAttribute('aria-label') || element.getAttribute('title') || (element.textContent || '').trim() || element.getAttribute('placeholder') || '').trim();
        elements.push({ ref, role, name: cap(name, 512), tagName: element.tagName.toLowerCase() });
      });
      return {
        accessibilityTree: cap(document.body?.innerText || ''),
        elements,
        origin: location.origin,
        title: document.title,
        truncated: nodes.length >= 500,
        url: location.href,
      };
    }
    if (operation === 'click') return perform('click', node());
    if (operation === 'element-action') return perform(String(input.kind || ''), node());
    if (operation === 'fill') return setText(node(), input.text, false);
    if (operation === 'type') return setText(node(), input.text, true);
    if (operation === 'keyboard' || operation === 'insert-text') {
      const target = document.activeElement || document.body;
      return setText(target, input.text, true);
    }
    if (operation === 'press') {
      const target = document.activeElement || document.body;
      const key = String(input.key || '');
      target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key }));
      target.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key }));
      if (key === 'Enter' && target instanceof HTMLButtonElement) target.click();
      return { ok: true };
    }
    if (operation === 'select') {
      const target = node();
      if (!(target instanceof HTMLSelectElement)) throw new Error('Browser element is not a select');
      const values = Array.isArray(input.values) ? input.values.map(String) : [String(input.value || '')];
      Array.from(target.options).forEach(option => { option.selected = values.includes(option.value); });
      trigger(target, 'input'); trigger(target, 'change');
      return { ok: true, values: Array.from(target.selectedOptions).map(option => option.value) };
    }
    if (operation === 'drag') {
      const sourceSelector = input.sourceSelector || refSelector(input.sourceRef);
      const targetSelector = input.targetSelector || refSelector(input.targetRef);
      const source = sourceSelector && document.querySelector(String(sourceSelector));
      const target = targetSelector && document.querySelector(String(targetSelector));
      if (!source || !target) throw new Error('Browser drag source or target is unavailable');
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true }));
      target.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
      return { ok: true };
    }
    if (operation === 'wait') {
      const mode = String(input.mode || 'selector');
      const timeoutMs = Math.max(100, Math.min(${MAX_NATIVE_BROWSER_DOWNLOAD_TIMEOUT_MS}, Number(input.timeoutMs) || 30000));
      const startedAt = Date.now();
      if (mode === 'time') {
        return new Promise(resolve => setTimeout(() => resolve({ ok: true }), Math.min(timeoutMs, Number(input.durationMs) || 1000)));
      }
      const matches = () => {
        if (mode === 'url') return location.href.includes(String(input.value || ''));
        if (mode === 'text') return (document.body?.innerText || '').includes(String(input.value || ''));
        if (mode === 'function') {
          const expression = String(input.value || '');
          if (!expression || expression.length > ${MAX_NATIVE_BROWSER_SCRIPT}) throw new Error('Browser wait function is invalid');
          return Boolean(eval(expression));
        }
        if (mode === 'load') {
          const state = String(input.value || 'load');
          if (state === 'networkidle') return document.readyState === 'complete';
          if (state === 'domcontentloaded') return document.readyState === 'interactive' || document.readyState === 'complete';
          return document.readyState === 'complete';
        }
        const target = node();
        const state = String(input.state || 'visible');
        if (state === 'attached') return true;
        if (state === 'detached') return !document.querySelector(selector);
        const style = getComputedStyle(target);
        const visible = style.visibility !== 'hidden' && style.display !== 'none'
          && target.getBoundingClientRect().width > 0 && target.getBoundingClientRect().height > 0;
        return state === 'hidden' ? !visible : visible;
      };
      return new Promise((resolve, reject) => {
        const poll = () => {
          try {
            if (matches()) return resolve({ ok: true });
          } catch (error) {
            if (mode !== 'selector' || String(error?.message || '').includes('unavailable') === false) return reject(error);
          }
          if (Date.now() - startedAt >= timeoutMs) return reject(new Error('Desktop Browser wait timed out'));
          setTimeout(poll, 50);
        };
        poll();
      });
    }
    if (operation === 'get') {
      const what = String(input.what || '');
      if (what === 'title') return { value: document.title };
      if (what === 'url') return { value: location.href };
      const target = node();
      if (what === 'text') return { value: cap(target.textContent || '') };
      if (what === 'html') return { value: cap(target.innerHTML || '') };
      if (what === 'value') return { value: cap(inputValue(target)) };
      if (what === 'attr') return { value: target.getAttribute(String(input.attribute || '')) };
      if (what === 'count') return { value: document.querySelectorAll(selector).length };
      if (what === 'box') {
        const box = target.getBoundingClientRect();
        return { value: { x: box.x, y: box.y, width: box.width, height: box.height } };
      }
      if (what === 'styles') {
        const styles = getComputedStyle(target);
        return { value: { display: styles.display, visibility: styles.visibility, opacity: styles.opacity } };
      }
      throw new Error('Unsupported Browser get type');
    }
    if (operation === 'is') {
      const target = node();
      const state = String(input.state || '');
      if (state === 'visible') {
        const style = getComputedStyle(target);
        const box = target.getBoundingClientRect();
        return { value: style.visibility !== 'hidden' && style.display !== 'none' && box.width > 0 && box.height > 0 };
      }
      if (state === 'enabled') return { value: !('disabled' in target) || !target.disabled };
      if (state === 'checked') return { value: target instanceof HTMLInputElement && target.checked };
      throw new Error('Unsupported Browser element state');
    }
    if (operation === 'find') {
      const locator = String(input.locator || '');
      const value = String(input.value || '');
      let candidates = [];
      if (locator === 'text') candidates = Array.from(document.querySelectorAll('*')).filter(element => (element.textContent || '').trim() === value);
      else if (locator === 'label') candidates = Array.from(document.querySelectorAll('label')).filter(element => (element.textContent || '').trim() === value).map(label => document.getElementById(label.htmlFor)).filter(Boolean);
      else if (locator === 'placeholder') candidates = Array.from(document.querySelectorAll('[placeholder]')).filter(element => element.getAttribute('placeholder') === value);
      else if (locator === 'testid') candidates = Array.from(document.querySelectorAll('[data-testid]')).filter(element => element.getAttribute('data-testid') === value);
      else if (locator === 'role') candidates = Array.from(document.querySelectorAll('[role],button,a,input')).filter(element => (element.getAttribute('role') || element.tagName.toLowerCase()) === value);
      else if (locator === 'nth') candidates = [document.querySelector(value)].filter(Boolean);
      else candidates = [document.querySelector(value)].filter(Boolean);
      const target = candidates[locator === 'nth' ? Number(input.index) || 0 : 0];
      if (!(target instanceof Element)) throw new Error('Browser find target is unavailable');
      const action = String(input.action || 'click');
      if (action === 'fill') return setText(target, input.text, false);
      if (action === 'type') return setText(target, input.text, true);
      return perform(action, target);
    }
    if (operation === 'evaluate') {
      const expression = String(input.expression || '');
      if (!expression || expression.length > ${MAX_NATIVE_BROWSER_SCRIPT}) throw new Error('Browser JavaScript expression is invalid');
      return { result: eval(expression) };
    }
    if (operation === 'storage') {
      const store = input.storageType === 'session' ? sessionStorage : localStorage;
      const action = String(input.operation || 'get');
      const key = String(input.key || '');
      if (action === 'get') return { value: key ? store.getItem(key) : Object.fromEntries(Object.keys(store).map(item => [item, store.getItem(item)])) };
      if (action === 'set') { store.setItem(key, String(input.value || '')); return { ok: true }; }
      if (action === 'clear') { store.clear(); return { ok: true }; }
      throw new Error('Unsupported Browser storage action');
    }
    if (operation === 'upload') {
      const target = node();
      if (!(target instanceof HTMLInputElement) || target.type !== 'file') throw new Error('Browser element is not a file input');
      const files = Array.isArray(input.files) ? input.files : [];
      const transfer = new DataTransfer();
      files.forEach(file => {
        const binary = atob(String(file.data || ''));
        const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
        transfer.items.add(new File([bytes], String(file.name || 'upload'), { type: String(file.type || 'application/octet-stream') }));
      });
      target.files = transfer.files;
      trigger(target, 'input'); trigger(target, 'change');
      return { ok: true, count: transfer.files.length };
    }
    if (operation === 'wheel') { window.scrollBy(Number(input.deltaX) || 0, Number(input.deltaY) || 0); return { ok: true }; }
    throw new Error('Unsupported Desktop Browser operation: ' + operation);
  })()`
}

const NATIVE_BROWSER_FILE_SELECTION_GUARD = `(() => {
  if (window.__farmingNativeFileSelectionGuard) return;
  window.__farmingNativeFileSelectionGuard = true;
  const blocked = event => {
    const target = event.target instanceof Element
      ? event.target.closest('input[type="file"]')
      : null;
    if (!target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    console.warn('FARMING_NATIVE_BROWSER_FILE_SELECTION_BLOCKED');
  };
  document.addEventListener('click', blocked, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') blocked(event);
  }, true);
})()`

const NATIVE_BROWSER_INTERACTION_SHIELD_URL = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      html, body { width: 100%; height: 100%; margin: 0; background: transparent; cursor: not-allowed; }
    </style>
  </head>
  <body tabindex="0">
    <script>
      for (const type of [
        'auxclick', 'beforeinput', 'click', 'contextmenu', 'dblclick', 'dragend',
        'dragenter', 'dragleave', 'dragover', 'dragstart', 'drop', 'input',
        'keydown', 'keypress', 'keyup', 'mousedown', 'mouseenter', 'mouseleave',
        'mousemove', 'mouseup', 'paste', 'pointercancel', 'pointerdown',
        'pointerenter', 'pointerleave', 'pointermove', 'pointerup', 'touchend',
        'touchmove', 'touchstart', 'wheel',
      ]) {
        document.addEventListener(type, event => {
          event.preventDefault();
          event.stopImmediatePropagation();
        }, { capture: true });
      }
    </script>
  </body>
</html>`)}`

export class DesktopNativeBrowserController {
  readonly adapterId: string
  private readonly getWindow: () => BrowserWindow | null
  private readonly onEvent: (event: DesktopNativeBrowserEvent) => void
  private readonly sessions = new Map<string, NativeBrowserSession>()
  private readonly resourceTabs = new Map<string, NativeBrowserTab>()
  private readonly configuredPartitions = new Set<string>()
  private backendEpoch = ''

  constructor(options: DesktopNativeBrowserControllerOptions) {
    this.adapterId = options.adapterId || crypto.randomUUID()
    this.getWindow = options.getWindow
    this.onEvent = options.onEvent
  }

  async command(command: DesktopNativeBrowserCommand): Promise<unknown> {
    const operation = text(command.operation, 128)
    if (!text(command.resourceId, 256) || !text(command.sessionId, 256) || !operation) {
      throw nativeBrowserError('Desktop Browser command is invalid', 'BROWSER_DESKTOP_COMMAND_INVALID')
    }
    if (!Number.isSafeInteger(command.generation) || command.generation < 0) {
      throw nativeBrowserError('Desktop Browser generation is invalid', 'BROWSER_DESKTOP_COMMAND_INVALID')
    }
    const input = recordValue(command.input)
    if (operation === 'start') {
      this.commandResourceId(command, input)
      return this.start(command, input)
    }
    if (operation === 'clear-session-data') {
      this.commandResourceId(command, input)
      return this.clearSessionData(command)
    }
    if (operation === 'close-session') {
      this.commandResourceId(command, input)
      return this.closeSession(command.sessionId)
    }
    if (operation === 'create-tab') return this.createResourceTab(command, input)
    if (operation === 'bind-tab') {
      this.commandResourceId(command, input)
      return this.bindTab(command, input)
    }
    if (operation === 'list-tabs') {
      const tab = this.requireTab(command, input)
      return this.tabs(this.requireSession(tab.sessionId))
    }
    if (operation === 'switch-tab') {
      return this.switchTab(command, input, this.requireTab(command, input))
    }
    if (operation === 'close-tab') {
      return this.closeTab(command, input, this.requireTab(command, input))
    }
    const tab = this.requireTab(command, input)
    if (operation === 'prepare-control') return this.prepareControl(tab, input)
    if (operation === 'commit-control') return this.commitControl(tab, input)
    if (operation === 'cancel-control') return this.cancelControl(tab, input)
    this.assertTabControl(tab, input)
    if (operation === 'get-zoom') return { zoomFactor: tab.view.webContents.getZoomFactor() }
    if (operation === 'zoom-in') return this.setZoom(tab, tab.view.webContents.getZoomFactor() + NATIVE_BROWSER_ZOOM_STEP)
    if (operation === 'zoom-out') return this.setZoom(tab, tab.view.webContents.getZoomFactor() - NATIVE_BROWSER_ZOOM_STEP)
    if (operation === 'reset-zoom') return this.setZoom(tab, 1)
    if (operation === 'set-zoom') return this.setZoom(tab, nativeBrowserZoomFactor(input.zoomFactor))
    if (operation === 'navigate') return this.navigate(tab, normalizeNativeBrowserUrl(input.url))
    if (operation === 'back') return this.navigation(tab, () => tab.view.webContents.goBack())
    if (operation === 'forward') return this.navigation(tab, () => tab.view.webContents.goForward())
    if (operation === 'reload') return this.navigation(tab, () => tab.view.webContents.reload())
    if (operation === 'stop-loading') {
      tab.view.webContents.stop()
      return this.metadata(tab)
    }
    if (operation === 'resize') return this.metadata(tab)
    if (operation === 'screenshot') return this.screenshot(tab)
    if (operation === 'cookies') return this.cookies(tab, input)
    if (operation === 'download') return this.download(tab, input)
    if (['debug-log', 'network', 'pointer', 'frame', 'dialog'].includes(operation)) {
      throw nativeBrowserError(
        `Desktop Browser does not support ${operation}; use a Browser source with that structured capability.`,
        'BROWSER_DESKTOP_OPERATION_UNSUPPORTED',
      )
    }
    return tab.view.webContents.executeJavaScript(nativeBrowserDomScript(operation, input), true)
  }

  async mount(resourceId: string, generation: number, bounds: DesktopNativeBrowserBounds): Promise<void> {
    const tab = this.requireResourceTab(resourceId, generation)
    const nativeSession = this.requireSession(tab.sessionId)
    if (nativeSession.activeTabId !== tab.id) {
      throw nativeBrowserError(
        'Desktop Browser tab must be selected through the backend before mounting',
        'BROWSER_STALE_GENERATION',
      )
    }
    const window = this.getWindow()
    if (!window || window.isDestroyed()) throw nativeBrowserError('Farming Desktop window is unavailable', 'BROWSER_DESKTOP_ADAPTER_UNAVAILABLE')
    const next = clampNativeBrowserBounds(bounds)
    this.hideAllExcept(tab)
    tab.view.setBounds({
      height: next.height,
      width: next.width,
      x: next.x,
      y: next.y,
    })
    tab.interactionShield.setBounds({
      height: next.height,
      width: next.width,
      x: next.x,
      y: next.y,
    })
    tab.mounted = next.width > 0 && next.height > 0
    this.setTabVisible(tab, tab.mounted)
  }

  async unmount(resourceId: string, generation: number): Promise<void> {
    const tab = this.requireResourceTab(resourceId, generation)
    tab.mounted = false
    this.setTabVisible(tab, false)
  }

  async focus(resourceId: string, generation: number): Promise<void> {
    const tab = this.requireResourceTab(resourceId, generation)
    if (tab.controlOwner !== 'user' || tab.pendingControl) {
      throw nativeBrowserError(
        'Take control before focusing this Desktop Browser tab',
        'BROWSER_AGENT_CONTROL_ACTIVE',
      )
    }
    if (!tab.mounted) return
    this.hideAllExcept(tab)
    this.setTabVisible(tab, true)
    tab.view.webContents.focus()
  }

  async reconcileBackendEpoch(serverEpoch: string): Promise<void> {
    const next = text(serverEpoch, 256)
    if (!next) throw nativeBrowserError('Farming backend epoch is invalid', 'BROWSER_DESKTOP_COMMAND_INVALID')
    if (this.backendEpoch && this.backendEpoch !== next) {
      await this.dispose()
    }
    this.backendEpoch = next
  }

  async invalidateLease(): Promise<void> {
    await this.dispose()
    this.backendEpoch = ''
  }

  async dispose(): Promise<void> {
    for (const session of [...this.sessions.values()]) {
      await this.destroySession(session)
    }
  }

  hideAll(): void {
    for (const nativeSession of this.sessions.values()) {
      for (const tab of nativeSession.tabs.values()) this.setTabVisible(tab, false)
    }
  }

  private hideAllExcept(visibleTab: NativeBrowserTab): void {
    for (const nativeSession of this.sessions.values()) {
      for (const tab of nativeSession.tabs.values()) {
        if (tab !== visibleTab) this.setTabVisible(tab, false)
      }
    }
  }

  private setTabVisible(tab: NativeBrowserTab, visible: boolean): void {
    tab.view.setVisible(visible)
    // A prepare phase must keep the page shielded even when the current owner
    // is the user. Otherwise a user-to-Agent handoff has a short interval in
    // which direct native input can race ahead of the persisted epoch.
    tab.interactionShield.setVisible(
      visible && (tab.controlOwner !== 'user' || tab.pendingControl !== null),
    )
  }

  private async start(command: DesktopNativeBrowserCommand, input: Record<string, unknown>) {
    let session = this.sessions.get(command.sessionId)
    if (!session) {
      session = {
        activeTabId: '',
        closing: false,
        id: command.sessionId,
        partition: nativeBrowserPartition(command.sessionId),
        tabs: new Map(),
      }
      this.sessions.set(session.id, session)
    }
    const current = this.resourceTabs.get(command.resourceId)
    if (
      current
      && current.generation === command.generation
      && current.sessionId === command.sessionId
    ) return this.metadata(current)
    if (current && current.generation === command.generation) {
      throw nativeBrowserError(
        'Desktop Browser Resource is leased by another native session',
        'BROWSER_STALE_GENERATION',
      )
    }
    if (current) {
      const previousSession = this.sessions.get(current.sessionId)
      if (previousSession) await this.destroyTab(previousSession, current)
    }
    const created = await this.createTab(
      session,
      command.resourceId,
      command.generation,
      normalizeNativeBrowserUrl(input.url),
      'agent',
      nativeBrowserControlEpoch(input.controlEpoch, 'Desktop Browser start control epoch'),
    )
    return {
      ...created,
      title: text(this.resourceTabs.get(command.resourceId)?.view.webContents.getTitle(), 512),
      url: this.resourceTabs.get(command.resourceId)?.view.webContents.getURL() || normalizeNativeBrowserUrl(input.url),
    }
  }

  private async createTab(
    nativeSession: NativeBrowserSession,
    resourceId: string,
    generation: number,
    url: string,
    controlOwner: NativeBrowserTab['controlOwner'] = 'agent',
    controlEpoch = 0,
    activate = true,
  ) {
    const window = this.getWindow()
    if (!window || window.isDestroyed()) {
      throw nativeBrowserError('Farming Desktop window is unavailable', 'BROWSER_DESKTOP_ADAPTER_UNAVAILABLE')
    }
    const id = `native:${crypto.randomUUID()}`
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        partition: nativeSession.partition,
        sandbox: true,
      },
    })
    const interactionShield = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        partition: nativeSession.partition,
        sandbox: true,
      },
    })
    interactionShield.setBackgroundColor('#00000000')
    window.contentView.addChildView(view)
    window.contentView.addChildView(interactionShield)
    view.setVisible(false)
    interactionShield.setVisible(false)
    const tab: NativeBrowserTab = {
      closing: false,
      controlEpoch,
      controlOwner,
      generation,
      id,
      interactionShield,
      loading: false,
      mounted: false,
      pendingControl: null,
      pendingErrors: [],
      resourceId,
      sessionId: nativeSession.id,
      view,
    }
    nativeSession.tabs.set(id, tab)
    if (activate || !nativeSession.activeTabId) nativeSession.activeTabId = id
    this.resourceTabs.set(resourceId, tab)
    this.configureSession(nativeSession, view.webContents.session)
    this.observeTab(nativeSession, tab)
    await interactionShield.webContents.loadURL(NATIVE_BROWSER_INTERACTION_SHIELD_URL)
    await view.webContents.loadURL(url)
    this.emitTabs(nativeSession, tab, [id])
    return {
      tabId: id,
      tabs: this.tabs(nativeSession),
    }
  }

  private async createResourceTab(
    command: DesktopNativeBrowserCommand,
    input: Record<string, unknown>,
  ) {
    const resourceId = this.commandResourceId(command, input)
    const nativeSession = this.requireSession(command.sessionId)
    const pendingResourceId = text(input.pendingResourceId, 256)
    if (!pendingResourceId.startsWith('popup:')) {
      throw nativeBrowserError(
        'Desktop Browser tab creation requires a pending Resource binding',
        'BROWSER_DESKTOP_COMMAND_INVALID',
      )
    }
    const controlEpoch = nativeBrowserControlEpoch(
      input.initialControlEpoch,
      'Desktop Browser initial tab control epoch',
    )
    if (input.unboundResource === true) {
      if (this.resourceTabs.has(resourceId) || nativeSession.tabs.size === 0) {
        throw nativeBrowserError(
          'Desktop Browser cannot create an unbound tab for this Resource lease',
          'BROWSER_STALE_GENERATION',
        )
      }
      return this.createTab(
        nativeSession,
        pendingResourceId,
        command.generation,
        normalizeNativeBrowserUrl(input.url),
        'agent',
        controlEpoch,
        false,
      )
    }
    const active = this.requireTab(command, input)
    this.assertTabControl(active, input)
    return this.createTab(
      nativeSession,
      pendingResourceId,
      command.generation,
      normalizeNativeBrowserUrl(input.url),
      'agent',
      controlEpoch,
    )
  }

  private async bindTab(command: DesktopNativeBrowserCommand, input: Record<string, unknown>) {
    const tabId = text(input.tabId, 256)
    const resourceId = text(input.resourceId, 256)
    const controlEpoch = nativeBrowserControlEpoch(
      input.controlEpoch,
      'Desktop Browser bound tab control epoch',
    )
    const controlOwner = input.controlOwner
    const nativeSession = this.requireSession(command.sessionId)
    const tab = nativeSession.tabs.get(tabId)
    if (
      !tab
      || !resourceId
      || resourceId !== command.resourceId
      || tab.sessionId !== command.sessionId
    ) {
      throw nativeBrowserError('Desktop Browser tab is unavailable', 'BROWSER_TAB_UNAVAILABLE')
    }
    if (
      (controlOwner !== 'agent' && controlOwner !== 'user')
      || tab.controlOwner !== controlOwner
      || tab.controlEpoch !== controlEpoch
      || tab.pendingControl
    ) {
      throw nativeBrowserError(
        'Desktop Browser tab control state is stale',
        'BROWSER_STALE_CONTROL',
      )
    }
    const previous = this.resourceTabs.get(resourceId)
    if (previous && previous !== tab) this.resourceTabs.delete(resourceId)
    this.resourceTabs.delete(tab.resourceId)
    tab.resourceId = resourceId
    tab.generation = command.generation
    this.resourceTabs.set(resourceId, tab)
    this.emit(tab, 'metadata', this.metadata(tab))
    this.emit(tab, 'loading', { loading: tab.loading })
    for (const message of tab.pendingErrors.splice(0)) {
      this.emit(tab, 'error', { message })
    }
    this.emit(tab, 'control', {
      controlEpoch: tab.controlEpoch,
      owner: tab.controlOwner,
    })
    return { tabs: this.tabs(nativeSession) }
  }

  private async switchTab(
    command: DesktopNativeBrowserCommand,
    input: Record<string, unknown>,
    expectedTab: NativeBrowserTab,
  ) {
    const nativeSession = this.requireSession(command.sessionId)
    const tabId = text(input.tabId, 256)
    const tab = nativeSession.tabs.get(tabId)
    if (!tab || tab !== expectedTab) {
      throw nativeBrowserError('Desktop Browser tab is unavailable', 'BROWSER_TAB_UNAVAILABLE')
    }
    nativeSession.activeTabId = tab.id
    if (tab.resourceId.startsWith('popup:')) {
      throw nativeBrowserError('Desktop Browser tab is still being assigned to a Browser Resource', 'BROWSER_TAB_UNAVAILABLE')
    }
    if (tab.controlOwner === 'user' && tab.mounted) {
      this.hideAllExcept(tab)
      this.setTabVisible(tab, true)
    }
    this.emitTabs(nativeSession, tab)
    return { tabs: this.tabs(nativeSession) }
  }

  private async closeTab(
    command: DesktopNativeBrowserCommand,
    input: Record<string, unknown>,
    expectedTab: NativeBrowserTab,
  ) {
    const nativeSession = this.requireSession(command.sessionId)
    const tabId = text(input.tabId, 256)
    const tab = nativeSession.tabs.get(tabId)
    if (!tab || tab !== expectedTab) {
      throw nativeBrowserError('Desktop Browser tab is unavailable', 'BROWSER_TAB_UNAVAILABLE')
    }
    await this.destroyTab(nativeSession, tab)
    return { tabs: this.tabs(nativeSession) }
  }

  private async navigate(tab: NativeBrowserTab, url: string) {
    await tab.view.webContents.loadURL(url)
    return this.metadata(tab)
  }

  private async navigation(tab: NativeBrowserTab, operation: () => void) {
    operation()
    return this.metadata(tab)
  }

  private assertTabControl(tab: NativeBrowserTab, input: Record<string, unknown>) {
    const owner = input.controlOwner
    const controlEpoch = nativeBrowserControlEpoch(input.controlEpoch)
    if (
      (owner !== 'agent' && owner !== 'user')
      || tab.pendingControl
      || tab.controlOwner !== owner
      || tab.controlEpoch !== controlEpoch
    ) {
      throw nativeBrowserError(
        'Desktop Browser control changed before this command could run',
        'BROWSER_STALE_CONTROL',
      )
    }
  }

  private prepareControl(tab: NativeBrowserTab, input: Record<string, unknown>) {
    const owner = input.owner
    const expectedOwner = input.expectedControlOwner
    const expectedControlEpoch = nativeBrowserControlEpoch(
      input.expectedControlEpoch,
      'Desktop Browser expected control epoch',
    )
    const controlEpoch = nativeBrowserControlEpoch(input.controlEpoch)
    if (
      (owner !== 'agent' && owner !== 'user')
      || (expectedOwner !== 'agent' && expectedOwner !== 'user')
    ) {
      throw nativeBrowserError('Desktop Browser control owner is invalid', 'BROWSER_INVALID_REQUEST')
    }
    if (
      tab.pendingControl
      || tab.controlOwner !== expectedOwner
      || tab.controlEpoch !== expectedControlEpoch
      || controlEpoch <= tab.controlEpoch
    ) {
      throw nativeBrowserError(
        'Desktop Browser control handoff is stale',
        'BROWSER_STALE_CONTROL',
      )
    }
    tab.pendingControl = { controlEpoch, owner }
    if (owner === 'agent' && tab.mounted) {
      // Returning control blocks direct native input before the backend commits
      // the new epoch. Pending control also fences delayed structured commands.
      this.setTabVisible(tab, true)
    }
    return { controlEpoch, owner }
  }

  private commitControl(tab: NativeBrowserTab, input: Record<string, unknown>) {
    const owner = input.owner
    const controlEpoch = nativeBrowserControlEpoch(input.controlEpoch)
    if (
      (owner !== 'agent' && owner !== 'user')
      || !tab.pendingControl
      || tab.pendingControl.owner !== owner
      || tab.pendingControl.controlEpoch !== controlEpoch
    ) {
      throw nativeBrowserError(
        'Desktop Browser control handoff is stale',
        'BROWSER_STALE_CONTROL',
      )
    }
    tab.pendingControl = null
    tab.controlEpoch = controlEpoch
    tab.controlOwner = owner
    if (owner === 'agent') {
      if (tab.mounted) this.setTabVisible(tab, true)
      this.getWindow()?.webContents.focus()
    } else {
      this.hideAllExcept(tab)
      if (tab.mounted) {
        this.setTabVisible(tab, true)
        tab.view.webContents.focus()
      }
    }
    this.emit(tab, 'control', { controlEpoch, owner })
    return { controlEpoch, owner }
  }

  private cancelControl(tab: NativeBrowserTab, input: Record<string, unknown>) {
    const owner = input.owner
    const controlEpoch = nativeBrowserControlEpoch(input.controlEpoch)
    if (
      (owner !== 'agent' && owner !== 'user')
      || !tab.pendingControl
      || tab.pendingControl.owner !== owner
      || tab.pendingControl.controlEpoch !== controlEpoch
    ) {
      throw nativeBrowserError(
        'Desktop Browser control handoff is stale',
        'BROWSER_STALE_CONTROL',
      )
    }
    tab.pendingControl = null
    if (tab.mounted) this.setTabVisible(tab, true)
    return { controlEpoch: tab.controlEpoch, owner: tab.controlOwner }
  }

  private setZoom(tab: NativeBrowserTab, value: number) {
    const zoomFactor = nativeBrowserZoomFactor(value)
    tab.view.webContents.setZoomFactor(zoomFactor)
    return { zoomFactor }
  }

  private async screenshot(tab: NativeBrowserTab) {
    const image = await tab.view.webContents.capturePage()
    const bytes = image.toPNG()
    if (bytes.byteLength > MAX_NATIVE_BROWSER_SCREENSHOT_BYTES) {
      throw nativeBrowserError('Desktop Browser screenshot exceeds the supported size', 'BROWSER_SCREENSHOT_TOO_LARGE')
    }
    return {
      data: bytes.toString('base64'),
      mimeType: 'image/png',
    }
  }

  private async cookies(tab: NativeBrowserTab, input: Record<string, unknown>) {
    const operation = text(input.operation || 'get', 32)
    const cookies = tab.view.webContents.session.cookies
    if (operation === 'get') return { cookies: await cookies.get({}) }
    if (operation === 'clear') {
      const current = await cookies.get({})
      await Promise.all(current.flatMap(cookie => {
        const domain = String(cookie.domain || '').replace(/^\./, '')
        if (!domain) return []
        const pathname = String(cookie.path || '/')
        return [cookies.remove(
          `${cookie.secure ? 'https' : 'http'}://${domain}${pathname}`,
          cookie.name,
        )]
      }))
      return { ok: true }
    }
    if (operation === 'set') {
      const url = normalizeNativeBrowserUrl(input.url || tab.view.webContents.getURL())
      const sameSite = nativeCookieSameSite(input.sameSite)
      await cookies.set({
        domain: text(input.domain, 512) || undefined,
        expirationDate: Number.isFinite(Number(input.expires)) ? Number(input.expires) : undefined,
        httpOnly: input.httpOnly === true,
        name: text(input.name, 1_024),
        path: text(input.path, 512) || undefined,
        ...(sameSite ? { sameSite } : {}),
        secure: input.secure === true,
        url,
        value: String(input.value ?? ''),
      })
      return { ok: true }
    }
    throw nativeBrowserError('Unsupported Browser cookie operation', 'BROWSER_INVALID_REQUEST')
  }

  private async download(tab: NativeBrowserTab, input: Record<string, unknown>) {
    const timeoutMs = boundedTimeout(input.timeoutMs, 30_000)
    const contents = tab.view.webContents
    const temporaryPath = path.join(
      os.tmpdir(),
      `farming-native-browser-download-${crypto.randomUUID()}`,
    )
    const selected = this.selectDownload(contents.session, contents, temporaryPath, timeoutMs)
    try {
      await contents.executeJavaScript(nativeBrowserDomScript('click', input), true)
      return await selected
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => {})
    }
  }

  private selectDownload(
    browserSession: Session,
    contents: WebContents,
    temporaryPath: string,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        browserSession.off('will-download', onDownload)
        callback()
      }
      const onDownload = (
        event: Event,
        downloadItem: DownloadItem,
        sourceContents: WebContents,
      ) => {
        if (sourceContents !== contents || settled) return
        event.preventDefault()
        downloadItem.setSavePath(temporaryPath)
        downloadItem.once('done', (_doneEvent, state) => {
          if (state !== 'completed') {
            finish(() => reject(nativeBrowserError(
              `Desktop Browser download ${state}`,
              'BROWSER_DOWNLOAD_FAILED',
            )))
            return
          }
          void (async () => {
            try {
              const stat = await fs.stat(temporaryPath)
              if (!stat.isFile()) {
                throw nativeBrowserError('Desktop Browser download did not produce a regular file', 'BROWSER_DOWNLOAD_FAILED')
              }
              if (stat.size > MAX_NATIVE_BROWSER_FILE_BYTES) {
                throw nativeBrowserError(
                  `Desktop Browser download exceeds ${MAX_NATIVE_BROWSER_FILE_BYTES} bytes`,
                  'BROWSER_DOWNLOAD_TOO_LARGE',
                )
              }
              const data = await fs.readFile(temporaryPath)
              finish(() => resolve({
                data: data.toString('base64'),
                mimeType: downloadItem.getMimeType() || 'application/octet-stream',
                name: path.basename(downloadItem.getFilename() || 'download'),
                size: stat.size,
              }))
            } catch (error) {
              finish(() => reject(error))
            }
          })()
        })
      }
      const timeout = setTimeout(() => {
        finish(() => reject(nativeBrowserError(
          'Desktop Browser download timed out; its outcome is uncertain. Refresh Browser state before retrying.',
          'BROWSER_DESKTOP_COMMAND_TIMEOUT',
          true,
        )))
      }, timeoutMs)
      timeout.unref?.()
      browserSession.prependListener('will-download', onDownload)
    })
  }

  private metadata(tab: NativeBrowserTab) {
    return {
      title: tab.view.webContents.getTitle().slice(0, 512),
      url: tab.view.webContents.getURL() || 'about:blank',
    }
  }

  private tabs(nativeSession: NativeBrowserSession) {
    return [...nativeSession.tabs.values()].map(tab => tabSummary(tab, tab.id === nativeSession.activeTabId))
  }

  private configureSession(nativeSession: NativeBrowserSession, browserSession: Session) {
    if (this.configuredPartitions.has(nativeSession.partition)) return
    this.configuredPartitions.add(nativeSession.partition)
    browserSession.setPermissionCheckHandler(() => false)
    browserSession.setPermissionRequestHandler((webContents, permission, callback) => {
      callback(false)
      const activeSession = this.sessionForPartition(nativeSession.partition)
      const source = [...(activeSession?.tabs.values() || [])]
        .find(tab => tab.view.webContents === webContents)
      if (source) {
        this.emit(source, 'error', {
          message: `Desktop Browser denied page permission: ${String(permission || 'unknown')}`,
        })
      }
    })
    browserSession.on('will-download', (event, _downloadItem, sourceContents) => {
      if ((event as Event & { defaultPrevented?: boolean }).defaultPrevented) return
      event.preventDefault()
      const activeSession = this.sessionForPartition(nativeSession.partition)
      const source = [...(activeSession?.tabs.values() || [])]
        .find(tab => tab.view.webContents === sourceContents)
      if (source) {
        this.emit(source, 'error', {
          message: 'Desktop Browser downloads must use the Project-workspace Browser download command.',
        })
      }
    })
  }

  private observeTab(nativeSession: NativeBrowserSession, tab: NativeBrowserTab) {
    const contents = tab.view.webContents
    const publishMetadata = () => this.emit(tab, 'metadata', this.metadata(tab))
    contents.on('before-input-event', (event, input) => {
      if (tab.closing) {
        event.preventDefault()
        return
      }
      if (tab.controlOwner !== 'user' || tab.pendingControl) {
        event.preventDefault()
        return
      }
      const key = String(input.key || '')
      const shortcut = input.control || input.meta
      if (input.type !== 'keyDown' || !shortcut) return
      if (key === '+' || key === '=') {
        event.preventDefault()
        this.setZoom(tab, contents.getZoomFactor() + NATIVE_BROWSER_ZOOM_STEP)
        return
      }
      if (key === '-') {
        event.preventDefault()
        this.setZoom(tab, contents.getZoomFactor() - NATIVE_BROWSER_ZOOM_STEP)
        return
      }
      if (key === '0') {
        event.preventDefault()
        this.setZoom(tab, 1)
      }
    })
    contents.on('did-start-loading', () => {
      if (tab.closing) return
      tab.loading = true
      this.emit(tab, 'loading', { loading: true })
    })
    contents.on('did-stop-loading', () => {
      if (tab.closing) return
      tab.loading = false
      this.emit(tab, 'loading', { loading: false })
      publishMetadata()
    })
    contents.on('page-title-updated', () => {
      if (!tab.closing) publishMetadata()
    })
    contents.on('did-navigate', () => {
      if (!tab.closing) publishMetadata()
    })
    contents.on('did-navigate-in-page', () => {
      if (!tab.closing) publishMetadata()
    })
    contents.on('did-finish-load', () => {
      void contents.executeJavaScript(NATIVE_BROWSER_FILE_SELECTION_GUARD, true).catch(() => {})
    })
    contents.on('console-message', (_event, _level, message) => {
      if (message !== 'FARMING_NATIVE_BROWSER_FILE_SELECTION_BLOCKED') return
      this.emit(tab, 'error', {
        message: 'Desktop Browser file selection is workspace-bounded; use the Browser upload command.',
      })
    })
    contents.on('did-fail-load', (_event, code, description, validatedUrl, isMainFrame) => {
      if (tab.closing || !isMainFrame || code === -3) return
      this.emit(tab, 'error', { message: `${description || 'Browser navigation failed'}${validatedUrl ? `: ${validatedUrl}` : ''}` })
    })
    const rejectUnsafeNavigation = (event: Event, url: string) => {
      try {
        normalizeNativeBrowserUrl(url)
      } catch (error) {
        event.preventDefault()
        this.emit(tab, 'error', { message: error instanceof Error ? error.message : String(error) })
      }
    }
    contents.on('will-navigate', rejectUnsafeNavigation)
    contents.on('will-redirect', rejectUnsafeNavigation)
    contents.setWindowOpenHandler(details => {
      try {
        const url = normalizeNativeBrowserUrl(details.url)
        const placeholder = `popup:${crypto.randomUUID()}`
        void this.createTab(
          nativeSession,
          placeholder,
          tab.generation,
          url,
          tab.controlOwner,
          tab.controlEpoch,
        )
          .then(created => this.emitTabs(nativeSession, tab, [String(created.tabId)]))
          .catch(error => this.emit(tab, 'error', { message: error instanceof Error ? error.message : String(error) }))
      } catch (error) {
        this.emit(tab, 'error', { message: error instanceof Error ? error.message : String(error) })
      }
      return { action: 'deny' }
    })
    contents.on('login', (event, _responseDetails, _authInfo, callback) => {
      event.preventDefault()
      callback('', '')
      this.emit(tab, 'error', { message: 'Desktop Browser authentication requires explicit page interaction.' })
    })
    contents.once('destroyed', () => {
      if (tab.closing || nativeSession.closing) return
      nativeSession.tabs.delete(tab.id)
      if (this.resourceTabs.get(tab.resourceId) === tab) this.resourceTabs.delete(tab.resourceId)
      if (nativeSession.activeTabId === tab.id) nativeSession.activeTabId = this.tabs(nativeSession)[0]?.tabId || ''
      this.emit(tab, 'tab-exit', { message: 'Desktop Browser tab closed unexpectedly' })
    })
  }

  private emitTabs(nativeSession: NativeBrowserSession, reference: NativeBrowserTab, newTabIds: string[] = []) {
    this.emit(reference, 'tabs', {
      newTabIds,
      popupAdmitted: true,
      tabs: this.tabs(nativeSession),
    })
  }

  private emit(tab: NativeBrowserTab, kind: string, payload?: Record<string, unknown>) {
    if (tab.resourceId.startsWith('popup:')) {
      if (kind === 'error') {
        const message = text(payload?.message, 2_000)
        if (message && tab.pendingErrors.length < 8) tab.pendingErrors.push(message)
      }
      return
    }
    this.onEvent({
      generation: tab.generation,
      kind,
      payload: {
        ...payload,
        tabId: tab.id,
      },
      resourceId: tab.resourceId,
      sessionId: tab.sessionId,
    })
  }

  private requireSession(id: string) {
    const value = this.sessions.get(id)
    if (!value || value.closing) {
      throw nativeBrowserError('Desktop Browser session is unavailable', 'BROWSER_NOT_RUNNING')
    }
    return value
  }

  private sessionForPartition(partition: string): NativeBrowserSession | null {
    for (const nativeSession of this.sessions.values()) {
      if (nativeSession.partition === partition && !nativeSession.closing) return nativeSession
    }
    return null
  }

  private requireResourceTab(resourceId: string, generation: number) {
    const tab = this.resourceTabs.get(resourceId)
    if (!tab || tab.generation !== generation || tab.closing) {
      throw nativeBrowserError('Desktop Browser Resource generation is stale', 'BROWSER_STALE_GENERATION')
    }
    return tab
  }

  private requireTab(command: DesktopNativeBrowserCommand, input: Record<string, unknown>) {
    const resourceId = this.commandResourceId(command, input)
    const tab = this.requireResourceTab(resourceId, command.generation)
    if (tab.sessionId !== command.sessionId) {
      throw nativeBrowserError('Desktop Browser Resource is leased by another native session', 'BROWSER_STALE_GENERATION')
    }
    return tab
  }

  private commandResourceId(
    command: DesktopNativeBrowserCommand,
    input: Record<string, unknown>,
  ) {
    const resourceId = text(command.resourceId, 256)
    const activeResourceId = text(input.activeResourceId || resourceId, 256)
    if (!resourceId || activeResourceId !== resourceId) {
      throw nativeBrowserError(
        'Desktop Browser command does not match its Resource lease',
        'BROWSER_STALE_GENERATION',
      )
    }
    return resourceId
  }

  private async closeSession(id: string) {
    const nativeSession = this.sessions.get(id)
    if (!nativeSession) return { ok: true }
    await this.destroySession(nativeSession)
    return { ok: true }
  }

  private async clearSessionData(command: DesktopNativeBrowserCommand) {
    const nativeSession = this.sessions.get(command.sessionId)
    if (nativeSession && !nativeSession.closing) {
      throw nativeBrowserError(
        'Desktop Browser session still has native tabs; stop every tab before clearing its profile',
        'BROWSER_DESKTOP_PROFILE_IN_USE',
      )
    }
    const partition = nativeBrowserPartition(command.sessionId)
    const browserSession = electronSession.fromPartition(partition)
    await browserSession.clearStorageData()
    await browserSession.clearCache()
    await browserSession.clearAuthCache()
    return { ok: true }
  }

  private async destroySession(nativeSession: NativeBrowserSession) {
    nativeSession.closing = true
    for (const tab of [...nativeSession.tabs.values()]) await this.destroyTab(nativeSession, tab)
    this.sessions.delete(nativeSession.id)
  }

  private async destroyTab(nativeSession: NativeBrowserSession, tab: NativeBrowserTab) {
    tab.closing = true
    tab.mounted = false
    nativeSession.tabs.delete(tab.id)
    if (this.resourceTabs.get(tab.resourceId) === tab) this.resourceTabs.delete(tab.resourceId)
    if (nativeSession.activeTabId === tab.id) nativeSession.activeTabId = this.tabs(nativeSession)[0]?.tabId || ''
    const window = this.getWindow()
    try {
      window?.contentView.removeChildView(tab.view)
    } catch {
      // The parent window may already be closing.
    }
    try {
      window?.contentView.removeChildView(tab.interactionShield)
    } catch {
      // The parent window may already be closing.
    }
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
    if (!tab.interactionShield.webContents.isDestroyed()) tab.interactionShield.webContents.close()
  }
}
