const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  isBrowserShortcut,
  isCopyShortcut,
  isPasteShortcut,
  getTerminalSequenceForKey,
} = require('../../frontend/app.js');

function makeEvent(overrides = {}) {
  return {
    key: '',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  };
}

function run() {
  assert.strictEqual(getTerminalSequenceForKey(makeEvent({ key: 'Enter' })), '\r');
  assert.strictEqual(getTerminalSequenceForKey(makeEvent({ key: 'ArrowUp' })), '\x1b[A');
  assert.strictEqual(getTerminalSequenceForKey(makeEvent({ key: 'Tab', shiftKey: true })), '\x1b[Z');
  assert.strictEqual(getTerminalSequenceForKey(makeEvent({ key: 'Backspace' })), '\x7f');
  assert.strictEqual(getTerminalSequenceForKey(makeEvent({ key: 'a' })), null);

  const originalNavigator = global.navigator;
  Object.defineProperty(global, 'navigator', {
    value: { platform: 'MacIntel' },
    configurable: true,
  });
  assert.strictEqual(isBrowserShortcut(makeEvent({ key: 'c', metaKey: true })), true);
  assert.strictEqual(isBrowserShortcut(makeEvent({ key: 't', metaKey: true })), true);
  assert.strictEqual(isCopyShortcut(makeEvent({ key: 'c', metaKey: true })), true);
  assert.strictEqual(isPasteShortcut(makeEvent({ key: 'v', metaKey: true })), true);
  assert.strictEqual(isBrowserShortcut(makeEvent({ key: 'ArrowUp' })), false);

  Object.defineProperty(global, 'navigator', {
    value: { platform: 'Linux x86_64' },
    configurable: true,
  });
  assert.strictEqual(isBrowserShortcut(makeEvent({ key: 'c', ctrlKey: true })), true);
  assert.strictEqual(isBrowserShortcut(makeEvent({ key: 'w', ctrlKey: true })), true);
  assert.strictEqual(isCopyShortcut(makeEvent({ key: 'c', ctrlKey: true })), true);
  assert.strictEqual(isPasteShortcut(makeEvent({ key: 'v', ctrlKey: true })), true);
  assert.strictEqual(isBrowserShortcut(makeEvent({ key: 'a' })), false);

  const sessionModalSource = fs.readFileSync(
    path.join(__dirname, '../../src/components/SessionModal.tsx'),
    'utf8'
  );
  const copyShortcutBranch = sessionModalSource.slice(
    sessionModalSource.indexOf('if (isCopyShortcut(e))'),
    sessionModalSource.indexOf('// Paste shortcut')
  );
  assert(
    copyShortcutBranch.includes('getSelectionNow()'),
    'React session copy shortcut should read terminal selection synchronously'
  );
  assert(
    copyShortcutBranch.includes('e.preventDefault()'),
    'React session copy shortcut should prevent the browser canvas copy default'
  );
  assert(
    !copyShortcutBranch.includes('await '),
    'React session copy shortcut must not await before preventing browser default copy'
  );
  assert(
    sessionModalSource.includes("window.addEventListener('copy', handleCopy, true)"),
    'React session modal should force copy events to text/plain selection data'
  );

  const terminalPoolSource = fs.readFileSync(
    path.join(__dirname, '../../src/lib/terminal-session-pool.ts'),
    'utf8'
  );
  const terminalBootstrapSource = fs.readFileSync(
    path.join(__dirname, '../../src/lib/terminal-bootstrap.ts'),
    'utf8'
  );
  const terminalLinksSource = fs.readFileSync(
    path.join(__dirname, '../../src/lib/terminal-links.ts'),
    'utf8'
  );
  const terminalSelectionSource = fs.readFileSync(
    path.join(__dirname, '../../src/lib/terminal-selection.ts'),
    'utf8'
  );
  const terminalViewportSource = fs.readFileSync(
    path.join(__dirname, '../../src/lib/terminal-viewport.ts'),
    'utf8'
  );
  const terminalOutputSource = fs.readFileSync(
    path.join(__dirname, '../../src/lib/terminal-output.ts'),
    'utf8'
  );
  const terminalResizeSource = fs.readFileSync(
    path.join(__dirname, '../../src/lib/terminal-resize.ts'),
    'utf8'
  );
  const terminalAttachmentSource = fs.readFileSync(
    path.join(__dirname, '../../src/lib/terminal-attachment.ts'),
    'utf8'
  );
  const terminalClipboardSource = fs.readFileSync(
    path.join(__dirname, '../../src/lib/terminal-clipboard.ts'),
    'utf8'
  );
  const terminalInputSource = fs.readFileSync(
    path.join(__dirname, '../../src/lib/terminal-input.ts'),
    'utf8'
  );
  const xtermSource = fs.readFileSync(
    path.join(__dirname, '../../src/lib/xterm.ts'),
    'utf8'
  );
  const pooledTerminalHookSource = fs.readFileSync(
    path.join(__dirname, '../../src/hooks/usePooledTerminal.ts'),
    'utf8'
  );
  const webSocketSource = fs.readFileSync(
    path.join(__dirname, '../../src/hooks/useWebSocket.ts'),
    'utf8'
  );
  const mainCssSource = fs.readFileSync(
    path.join(__dirname, '../../src/styles/main.css'),
    'utf8'
  );
  const codeComposerSource = fs.readFileSync(
    path.join(__dirname, '../../src/components/code/CodeComposer.tsx'),
    'utf8'
  );
  const terminalEngineSource = fs.readFileSync(
    path.join(__dirname, '../../src/lib/terminal-engine.ts'),
    'utf8'
  );
  assert(
    mainCssSource.includes('min-width: 148px') &&
      mainCssSource.includes('max-width: min(210px, calc(100vw - 32px))') &&
      mainCssSource.includes('font-size: 13px') &&
      mainCssSource.includes('.code-context-window-popover span {\n  color: #85888c;\n  font-size: 12px;') &&
      !codeComposerSource.includes('title={contextWindowTitle}'),
    'Code composer context-window tooltip should stay compact and avoid duplicate native title tooltips'
  );
  assert(
    mainCssSource.includes('.terminal-session-host textarea:not(.xterm-helper-textarea)') &&
      !mainCssSource.includes('.terminal-session-host textarea,\n.terminal-session-host [contenteditable') &&
      !mainCssSource.includes('.terminal-session-host .xterm-helper-textarea {\n  pointer-events: auto !important;\n  opacity: 0 !important;'),
    'xterm IME input should keep xterm helper textarea out of Farming generic transparent textarea rules'
  );
  assert(
    terminalPoolSource.includes('export function getTerminalSelectionNow'),
    'terminal session pool should expose synchronous selection reads for copy'
  );
  assert(
    terminalPoolSource.includes("export { normalizeTerminalSelection } from '@/lib/terminal-selection'") &&
      terminalSelectionSource.includes('export function normalizeTerminalSelection'),
    'terminal selection normalization should live in the dedicated selection helper module'
  );
  assert(
    terminalSelectionSource.includes("line?.isWrapped ? '' : '\\n'") ||
      terminalSelectionSource.includes("currentLine?.isWrapped ? '' : '\\n'"),
    'terminal selection normalization should remove only soft-wrap newlines'
  );
  assert(
    terminalSelectionSource.includes('readLineSelectionText') &&
      terminalSelectionSource.includes('getCell') &&
      terminalSelectionSource.includes('getChars'),
    'terminal selection normalization should rebuild text from cells to skip wide-character filler cells'
  );
  assert(
    terminalPoolSource.includes('onSelectionChange'),
    'terminal session pool should keep a current selection cache'
  );
  assert(
    terminalPoolSource.includes('selectContinuousTextAtCell') &&
      terminalPoolSource.includes("hostEl.addEventListener('dblclick'") &&
      terminalSelectionSource.includes('!/\\s/u.test(value)'),
    'terminal session pool should select continuous non-whitespace text on double click'
  );
  const copyTextAtEventBody = terminalPoolSource.slice(
    terminalPoolSource.indexOf('function getTerminalCopyTextAtEvent'),
    terminalPoolSource.indexOf('function installTerminalTouchInteraction')
  );
  assert(
    copyTextAtEventBody.includes('if (selection) return selection') &&
      terminalPoolSource.includes('contextMenuSelection') &&
      terminalPoolSource.includes("event.button !== 2") &&
      terminalLinksSource.includes('export function parseTerminalPathLinkAtColumn') &&
      terminalPoolSource.includes('function findTerminalPathLinkAtMouseEvent') &&
      terminalPoolSource.includes('function isTerminalEventInsideSelection') &&
      terminalPoolSource.includes('const selectionAtEvent = Boolean(selection) && isTerminalEventInsideSelection(record, event)') &&
      copyTextAtEventBody.includes('const pathLink = record.pathOpenHandler ? findTerminalPathLinkAtMouseEvent(record, event) : null') &&
      copyTextAtEventBody.includes('if (pathLink?.text && (!selectionAtEvent || pathLink.text.includes(compactSelection)))') &&
      terminalPoolSource.includes("window.addEventListener('contextmenu', contextMenuHandler, true)") &&
      copyTextAtEventBody.includes('if (isMobileViewport())') &&
      copyTextAtEventBody.includes('return selectContinuousTextAtCell(record, cell.col, cell.row)'),
    'terminal context-menu copy should preserve xterm selection, copy URL/path links at the click point, and only fall back to clicked text on mobile'
  );
  assert(
    terminalPoolSource.includes('fetchSessionBootstrapStateForCurrentTerminal') &&
      terminalPoolSource.includes('bootstrapDimensionsMatchTerminal') &&
      terminalPoolSource.includes('BOOTSTRAP_DIMENSION_RETRY_COUNT') &&
      terminalBootstrapSource.includes('parseSessionDimensions') &&
      terminalBootstrapSource.includes('textOutput: trimmedTextOutput'),
    'terminal bootstrap replay should verify backend snapshot dimensions before replacing the frontend xterm buffer'
  );
  assert(
    terminalPoolSource.includes('function selectTerminalCellRange') &&
      terminalPoolSource.includes('if (!isXtermTerminal(terminal)) {') &&
      terminalPoolSource.includes("hostEl.addEventListener('mousedown', mouseDownSelectionHandler, true)") &&
      terminalPoolSource.includes("window.addEventListener('mousemove', mouseMoveSelectionHandler, true)") &&
      terminalPoolSource.includes("window.addEventListener('mouseup', mouseUpSelectionHandler, true)") &&
      terminalPoolSource.includes("hostEl.addEventListener('pointerdown', pointerDownSelectionHandler, true)") &&
      terminalPoolSource.includes("window.addEventListener('pointermove', pointerMoveSelectionHandler, true)") &&
      terminalPoolSource.includes("window.addEventListener('pointerup', pointerUpSelectionHandler, true)") &&
      terminalPoolSource.includes("window.addEventListener('pointercancel', pointerUpSelectionHandler, true)") &&
      terminalPoolSource.includes("event.pointerType === 'touch'") &&
      terminalPoolSource.includes('record.suppressClickUntil = Date.now() + 250') &&
      terminalPoolSource.includes('Date.now() < record.suppressClickUntil') &&
      terminalPoolSource.includes("window.removeEventListener('mousemove', record.mouseMoveSelectionHandler, true)") &&
      terminalPoolSource.includes("window.removeEventListener('mouseup', record.mouseUpSelectionHandler, true)") &&
      terminalPoolSource.includes("window.removeEventListener('pointermove', record.pointerMoveSelectionHandler, true)") &&
      terminalPoolSource.includes("window.removeEventListener('pointerup', record.pointerUpSelectionHandler, true)") &&
      terminalPoolSource.includes("window.removeEventListener('pointercancel', record.pointerUpSelectionHandler, true)"),
    'terminal session pool should keep cell-based mouse and pointer drag selection on the non-xterm fallback path'
  );
  assert(
    terminalPoolSource.includes('setupTerminalImeOverlay') &&
      terminalPoolSource.includes('terminal-ime-composing') &&
      terminalPoolSource.includes('terminal-ime-active') &&
      terminalPoolSource.includes('setRendererCursorSuppressedForIme') &&
      terminalPoolSource.includes('suppressRendererCursor') &&
      terminalPoolSource.includes('shouldSuppressRendererCursor(record)') &&
      terminalPoolSource.includes('renderer.cursorVisible = false') &&
      terminalPoolSource.includes('rendererCursorWasVisible') &&
      terminalPoolSource.includes('installImeAwareRenderer') &&
      terminalPoolSource.includes('forceTerminalRender') &&
      terminalPoolSource.includes("record.hostEl.addEventListener('keydown'") &&
      terminalPoolSource.includes('event.keyCode === 229') &&
      terminalPoolSource.includes('wasmTerm?.getCursor') &&
      terminalPoolSource.includes('renderer?.getMetrics'),
    'terminal session pool should position IME text and suppress only the renderer cursor while composing'
  );
  assert(
    terminalOutputSource.includes('QUIET_TERMINAL_WRITE_THRESHOLD') &&
      terminalOutputSource.includes('record.suspendRendering = true') &&
      terminalPoolSource.includes('if (record.suspendRendering)') &&
      terminalOutputSource.includes('export function replaceTerminalOutput') &&
      terminalPoolSource.includes("from '@/lib/terminal-output'") &&
      terminalPoolSource.includes('replaceTerminalOutput(record, output,') &&
      terminalPoolSource.includes('replaceTerminalOutput(record, data'),
    'terminal session pool should restore snapshots and large output without visibly replaying every renderer frame'
  );
  assert(
      terminalPoolSource.includes('bootstrappingSnapshot') &&
      terminalPoolSource.includes('queuedOutput') &&
      terminalPoolSource.includes('function flushQueuedTerminalOutput') &&
      terminalPoolSource.includes('record.queuedOutput.push({ data, replace, outputSeq })') &&
      terminalPoolSource.includes('snapshotOutputSeq') &&
      terminalPoolSource.includes('function dropQueuedBootstrapEventsCoveredBySnapshot') &&
      terminalPoolSource.includes('isSequencedOutputCovered(event.outputSeq, checkpointSeq)') &&
      terminalBootstrapSource.includes('export function isSequencedOutputCovered') &&
      terminalPoolSource.includes("from '@/lib/terminal-bootstrap'") &&
      !terminalPoolSource.includes('snapshotOutput.includes(event.data)') &&
      terminalPoolSource.includes('flushQueuedTerminalOutput(record)'),
    'terminal session pool should buffer live stream chunks until bootstrap snapshot replay is finished and drop chunks covered by the snapshot sequence'
  );
  assert(
    terminalBootstrapSource.includes('export function trimLeadingBlankBootstrapRows(output: string)') &&
      terminalBootstrapSource.includes('output: trimmedOutput || snapshotOutput') &&
      terminalBootstrapSource.includes('export function bootstrapCursorMatchesOutput(output: string, snapshotOutput: string)') &&
      terminalBootstrapSource.includes('const cursor = !trimmedOutput || bootstrapCursorMatchesOutput(trimmedOutput, snapshotOutput)') &&
      terminalPoolSource.includes('return sessionBootstrapStateFromPayload(data)') &&
      !terminalPoolSource.includes('return sessionSnapshotToBootstrapText(parseSessionSnapshot(data)) || parseSessionOutput(data)'),
    'terminal bootstrap helper should prefer trimmed raw render output and only restore snapshot cursors from a matching coordinate space'
  );
  const repaintBody = terminalOutputSource.slice(
    terminalOutputSource.indexOf('export function scheduleTerminalRepaint'),
    terminalOutputSource.indexOf('export function scrollRecordToViewportY')
  );
  assert(
    !repaintBody.includes('setTimeout') &&
      (repaintBody.match(/requestAnimationFrame/g) || []).length <= 1,
    'terminal repaint fallback should stay lightweight'
  );
  assert(
    sessionModalSource.includes('shouldSuppressRendererCursorForAgent') &&
      sessionModalSource.includes("'claude'") &&
      sessionModalSource.includes('suppressRendererCursor: shouldSuppressRendererCursorForAgent(agent?.command)'),
    'React session modal should suppress the renderer hardware cursor for coding-agent TUIs'
  );
  assert(
    !terminalPoolSource.includes("record.terminal.write('\\x1b[?25l'") &&
      !terminalPoolSource.includes("record.terminal.write('\\x1b[?25h'"),
    'terminal IME cursor suppression should not mutate terminal protocol cursor visibility'
  );
  assert(
    terminalPoolSource.includes("hostEl.addEventListener('copy'") &&
      terminalPoolSource.includes('event.stopImmediatePropagation()') &&
      terminalPoolSource.includes("event.clipboardData?.setData('text/plain', selection)") &&
      terminalPoolSource.includes('function getXtermSelectionForCopy(record: SessionRecord)') &&
      terminalPoolSource.includes('record.terminal.getSelection() ||'),
    'terminal session pool should copy xterm selections through the xterm selection API'
  );
  assert(
    terminalClipboardSource.includes('export async function writeTerminalClipboardText') &&
      terminalClipboardSource.includes('navigator.clipboard?.writeText') &&
      terminalClipboardSource.includes("document.execCommand('copy')") &&
      terminalClipboardSource.includes('selection.removeAllRanges()') &&
      terminalClipboardSource.includes('export function createTerminalClipboardProvider') &&
      terminalClipboardSource.includes("selection === 'c'"),
    'terminal clipboard helper should own browser clipboard and textarea fallback behavior'
  );
  assert(
    terminalPoolSource.includes("from '@/lib/terminal-clipboard'") &&
      terminalPoolSource.includes('writeTerminalClipboardText(selection)') &&
      !terminalPoolSource.includes('async function writeClipboardText'),
    'terminal session pool should use the shared terminal clipboard helper for copy actions'
  );
  assert(
    xtermSource.includes("from '@/lib/terminal-clipboard'") &&
      xtermSource.includes('new ClipboardAddon(undefined, createTerminalClipboardProvider())') &&
      !xtermSource.includes('function createFarmingClipboardProvider') &&
      !xtermSource.includes('async function writeSystemClipboardText'),
    'xterm adapter should use the shared terminal clipboard provider'
  );
  assert(
    terminalInputSource.includes('export function shouldBlockDetachedTerminalPaste') &&
      terminalInputSource.includes('export function shouldHandleTerminalPasteEvent') &&
      terminalInputSource.includes('export function pasteTerminalText') &&
      terminalInputSource.includes("typeof destination.terminal.paste === 'function'") &&
      terminalInputSource.includes('destination.terminal.paste(text)') &&
      terminalInputSource.includes('destination.terminal.input(text, true)') &&
      terminalPoolSource.includes("from '@/lib/terminal-input'") &&
      terminalPoolSource.includes("hostEl.addEventListener('paste', pasteHandler, true)") &&
      terminalPoolSource.includes('shouldBlockDetachedTerminalPaste(record.hostEl, event, isAttached)') &&
      terminalPoolSource.includes('if (!shouldHandleTerminalPasteEvent(record.hostEl, event, isAttached)) return') &&
      terminalPoolSource.includes('if (isXtermTerminal(record.terminal))') &&
      terminalPoolSource.includes("record.hostEl.removeEventListener('paste', record.pasteHandler, true)") &&
      !terminalPoolSource.includes('function pasteTerminalText(record: SessionRecord, text: string)') &&
      terminalPoolSource.includes('dispatchPasteToTextarea'),
    'terminal session pool should let active xterm paste use xterm while blocking parked hosts and preserving fallback paste'
  );
  assert(
    xtermSource.includes("import { SearchAddon") &&
      xtermSource.includes('terminal.loadAddon(searchAddon)') &&
      xtermSource.includes('adapted.search = (term') &&
      xtermSource.includes('searchAddon.findNext') &&
      xtermSource.includes('searchAddon.findPrevious') &&
      xtermSource.includes('adapted.clearSearch = () =>'),
    'xterm should expose VS Code-style find support through the official SearchAddon'
  );
  assert(
    terminalPoolSource.includes('export async function searchTerminalSession') &&
      terminalPoolSource.includes('export async function clearTerminalSearch') &&
      terminalPoolSource.includes('record.terminal.search(term, direction, options)') &&
      terminalPoolSource.includes('window.__farmingTerminalTest') &&
      terminalPoolSource.includes('search: (agentId: string, term: string, direction?: TerminalSearchDirection)'),
    'terminal session pool should route terminal search by agent id and expose it to browser regression tests'
  );
  assert(
    terminalPoolSource.includes('if (!response.ok)') &&
      terminalPoolSource.includes('Terminal session view failed:') &&
      terminalPoolSource.includes('options.onError?.(error instanceof Error ? error : new Error(String(error)))') &&
      pooledTerminalHookSource.includes('onError?: (error: Error) => void') &&
      pooledTerminalHookSource.includes('handleError(error instanceof Error ? error : new Error(String(error)))'),
    'terminal session pool should surface bootstrap failures to the React terminal pane instead of failing silently'
  );
  assert(
    terminalPoolSource.includes('function getNativeTerminalSelection(hostEl: HTMLElement)') &&
      terminalPoolSource.includes('!isXtermTerminal(record.terminal) && options?.includeNativeFallback') &&
      terminalPoolSource.includes('getNativeTerminalSelection(record.hostEl)'),
    'terminal session pool should use native browser selection only for the non-xterm fallback path'
  );
  assert(
    xtermSource.includes('rightClickSelectsWord: false'),
    'xterm should match the VS Code default right-click behavior instead of mutating selection on right click'
  );
  assert(
    mainCssSource.includes('.terminal-session-host .xterm .xterm-rows') &&
      mainCssSource.includes('pointer-events: auto !important') &&
      !mainCssSource.includes('user-select: text !important') &&
      !mainCssSource.includes('.terminal-session-host .xterm .xterm-rows ::selection'),
    'xterm rows should keep pointer hit testing without forcing native browser text selection over xterm selection'
  );
  assert(
    terminalPoolSource.includes("hostEl.addEventListener('keydown', inputFallbackKeydownHandler, false)") &&
    terminalPoolSource.includes("hostEl.addEventListener('input', inputFallbackHandler, false)") &&
      terminalPoolSource.includes('if (isXtermTerminal(terminal)) return') &&
      terminalInputSource.includes('export function isXtermHelperTextareaTarget') &&
      terminalInputSource.includes("target.classList.contains('xterm-helper-textarea')") &&
      terminalInputSource.includes('export function shouldUseTerminalInputFallback') &&
      terminalInputSource.includes('export function shouldSuppressTerminalInputFallback') &&
      terminalInputSource.includes('TERMINAL_INPUT_FALLBACK_DELAY_MS = 80') &&
      terminalInputSource.includes('TERMINAL_INPUT_FALLBACK_SUPPRESSION_MS = 120') &&
      terminalPoolSource.includes('isXtermHelperTextareaTarget(event.target)') &&
      terminalPoolSource.includes('shouldUseTerminalInputFallback({') &&
      terminalPoolSource.includes('window.setTimeout(() =>') &&
      terminalPoolSource.includes('}, TERMINAL_INPUT_FALLBACK_DELAY_MS)') &&
      terminalPoolSource.includes('lastTerminalDataAt') &&
      terminalPoolSource.includes('record.lastTerminalDataAt = Date.now()') &&
      terminalPoolSource.includes('const inputEventAt = Date.now()') &&
      terminalPoolSource.includes('shouldSuppressTerminalInputFallback(record.lastTerminalDataAt, inputEventAt)') &&
      terminalPoolSource.includes('terminalInput(value, true)') &&
      terminalPoolSource.includes('window.clearTimeout(record.inputFallbackTimer)') &&
      terminalPoolSource.includes("record.hostEl.removeEventListener('keydown', record.inputFallbackKeydownHandler, false)") &&
      terminalPoolSource.includes("record.hostEl.removeEventListener('input', record.inputFallbackHandler, false)"),
    'terminal session pool should debounce residual helper textarea input through terminal.input without per-character duplication'
  );
  assert(
    terminalPoolSource.includes('readTerminalFontSize') &&
      terminalPoolSource.includes('dataset.terminalFontSize') &&
      terminalPoolSource.includes('input.style.fontSize'),
    'terminal IME overlay text should track host terminal font size'
  );
  assert(
    terminalResizeSource.includes('export const MIN_TERMINAL_RESIZE_COLS = 40') &&
      terminalResizeSource.includes('export const MIN_TERMINAL_RESIZE_ROWS = 10') &&
      terminalResizeSource.includes('export function proposeTerminalResizeDimensions') &&
      terminalResizeSource.includes('const hostRect = hostEl.getBoundingClientRect()') &&
      terminalResizeSource.includes('if (hostRect.width <= 0 || hostRect.height <= 0) return null') &&
      terminalResizeSource.includes('export function notifyTerminalResizeTracker') &&
      terminalResizeSource.includes('tracker.lastNotifiedResize.cols === next.cols') &&
      terminalResizeSource.includes('const delivered = onResize(next.cols, next.rows)') &&
      terminalResizeSource.includes('if (delivered === false) return false') &&
      terminalResizeSource.includes('tracker.resizeNotificationCount += 1') &&
      terminalResizeSource.includes('export function resetTerminalResizeTracker') &&
      terminalPoolSource.includes("from '@/lib/terminal-resize'") &&
      terminalPoolSource.includes('function notifyTerminalResize') &&
      terminalPoolSource.includes('if (!isTerminalSessionAttached(record)) return') &&
      terminalPoolSource.includes('notifyTerminalResizeTracker(record, cols, rows, onResize, options)') &&
      terminalPoolSource.includes('notifyResizeForTest(agentId: string, cols: number, rows: number)') &&
      terminalPoolSource.includes('function resyncTerminalSizeAfterBackendReconnect') &&
      terminalPoolSource.includes('function resyncTerminalOutputAfterBackendReconnect') &&
      terminalPoolSource.includes('needsReconnectOutputSync') &&
      terminalPoolSource.includes('record.needsReconnectOutputSync = true') &&
      terminalPoolSource.includes('record.needsReconnectOutputSync = false') &&
      terminalPoolSource.includes('function scheduleReconnectOutputSync') &&
      terminalPoolSource.includes('scheduleReconnectOutputSync(record, generation)') &&
      terminalPoolSource.includes('fetchSessionBootstrapState(record.agentId)') &&
      terminalPoolSource.includes('bootstrapState.outputSeq === null') &&
      terminalPoolSource.includes('isSequencedOutputCovered(bootstrapState.outputSeq, record.lastOutputSeq)') &&
      terminalPoolSource.includes('replaceTerminalOutput(record, bootstrapState.output') &&
      terminalPoolSource.includes('resetTerminalResizeTracker(record)') &&
      terminalPoolSource.includes("window.addEventListener('farming:backend-connected', backendConnectedHandler)") &&
      terminalPoolSource.includes("window.removeEventListener('farming:backend-connected', record.backendConnectedHandler)") &&
      terminalPoolSource.includes('notifyTerminalResize(record, dimensions.cols, dimensions.rows, onResize, options)') &&
      terminalPoolSource.includes('notifyTerminalResize(record, cols, rows)') &&
      webSocketSource.includes("window.dispatchEvent(new Event('farming:backend-connected'))"),
    'terminal session pool should not resize native sessions from hidden, unstable, duplicate, or stale reconnect measurements'
  );
  assert(
    terminalPoolSource.includes('hostEl.dataset.agentId = agentId'),
    'terminal session hosts should be tagged with their owning agent id'
  );
  assert(
    terminalAttachmentSource.includes('attachedMount: HTMLElement | null') &&
      terminalAttachmentSource.includes('attachGeneration: number') &&
      terminalAttachmentSource.includes('export function isCurrentTerminalAttachment') &&
      terminalAttachmentSource.includes('record.attachedMount = mountEl') &&
      terminalAttachmentSource.includes('export function attachTerminalHost') &&
      terminalPoolSource.includes("from '@/lib/terminal-attachment'") &&
      terminalPoolSource.includes('function isCurrentAttachment(record: SessionRecord, generation: number)') &&
      terminalPoolSource.includes('return isCurrentTerminalAttachment(record, generation)') &&
      terminalPoolSource.includes('function resetTransientTerminalUi(record: SessionRecord)') &&
      terminalPoolSource.includes('record.terminal.clearTerminalSelection?.()') &&
      terminalPoolSource.includes('function repairTerminalAfterAttach(record: SessionRecord)') &&
      terminalPoolSource.includes('record.terminal.reattach?.()') &&
      terminalPoolSource.includes('record.terminal.forceRedraw?.()') &&
      terminalPoolSource.includes('const generation = beginTerminalAttachment(record)') &&
      terminalPoolSource.includes('attachTerminalHost(record, mountEl') &&
      terminalPoolSource.includes('repairTerminalAfterAttach(record)') &&
      terminalPoolSource.includes('detachTerminalSession(agentId: string, expectedMount?: HTMLElement)') &&
      pooledTerminalHookSource.includes('detachTerminalSession(agentId, mountEl)') &&
      !pooledTerminalHookSource.includes('mountEl.replaceChildren()\n      detachTerminalSession'),
    'terminal session attach/detach should be scoped to the owning mount and repair xterm renderer state after reparenting'
  );
  assert(
    terminalPoolSource.includes('inputHandler: options.onInput') &&
      terminalPoolSource.includes('if (record.disposed || record.attachedMount === null) return') &&
      terminalPoolSource.includes('record.inputHandler(data)') &&
      terminalPoolSource.includes('record.inputHandler = options.onInput'),
    'terminal session pool should update input handlers without recreating the ghostty session and gate terminal input to the attached owner'
  );
  assert(
    pooledTerminalHookSource.includes('const latestHandlersRef = useRef') &&
      pooledTerminalHookSource.includes('latestHandlersRef.current.onInput(data)') &&
      !pooledTerminalHookSource.includes('}, [agentId, containerRef, onInput, onResize, onSessionOutput'),
    'pooled terminal hook should keep ghostty mounted across callback identity changes'
  );
  assert(
    mainCssSource.includes('.terminal-session-host textarea.terminal-ime-input.terminal-ime-composing') &&
      mainCssSource.includes('color: #1f2328 !important') &&
      !mainCssSource.includes('color: var(--theme-fg, #00ff41) !important'),
    'terminal IME composition text should use normal Codex text color instead of terminal green'
  );
  assert(
      terminalPoolSource.includes("record.hostEl.classList.toggle('terminal-renderer-cursor-suppressed'") &&
        mainCssSource.includes('.terminal-session-host.terminal-renderer-cursor-suppressed .xterm .xterm-cursor') &&
        mainCssSource.includes('background-color: transparent !important') &&
        mainCssSource.includes('opacity: 0 !important') &&
        mainCssSource.includes('contain: layout paint size'),
    'xterm terminal hosts should isolate paint and hide renderer cursors for coding-agent TUIs'
  );
  assert(
    terminalPoolSource.includes('if (sessions.get(agentId) !== record) return'),
    'terminal session pool should ignore stale attach/detach races after a session is destroyed'
  );
  assert(
    terminalPoolSource.includes('function findSessionRecordForHost(hostEl: HTMLDivElement)') &&
      terminalPoolSource.includes('function parkTerminalSessionRecord(record: SessionRecord)') &&
      terminalPoolSource.includes('record.followOutputHandler = null') &&
      terminalPoolSource.includes('record.pathOpenHandler = null') &&
      terminalAttachmentSource.includes('export function parkTerminalHost') &&
      terminalAttachmentSource.includes('record.attachedMount = null') &&
      terminalAttachmentSource.includes('record.attachGeneration += 1') &&
      terminalAttachmentSource.includes('getTerminalSessionParkingLot().appendChild(record.hostEl)') &&
      terminalPoolSource.includes('const record = findSessionRecordForHost(candidate)') &&
      terminalPoolSource.includes('parkTerminalSessionRecord(record)') &&
      terminalPoolSource.includes('function observeTerminalResize(record: SessionRecord)') &&
      terminalPoolSource.includes('function pauseTerminalResizeObserver(record: SessionRecord)') &&
      terminalPoolSource.includes('pauseTerminalResizeObserver(record)') &&
      terminalPoolSource.includes('observeTerminalResize(record)') &&
      !terminalPoolSource.includes('resizeObserver.observe(hostEl)') &&
      !terminalPoolSource.includes('function isolateSinglePaneTerminalMount(hostEl: HTMLDivElement, mountEl: HTMLElement) {\n  const terminalGrid = mountEl.closest(\'.code-terminal-grid.panes-1\')\n  if (!terminalGrid) return\n\n  terminalGrid.querySelectorAll(\'.terminal-session-host\').forEach(candidate => {\n    if (candidate === hostEl) return\n    if (!(candidate instanceof HTMLDivElement)) return\n    getTerminalSessionParkingLot().appendChild(candidate)'),
    'parking a terminal host should update attachment state and pause hidden layout observers, not only move DOM nodes'
  );
  assert(
    terminalPoolSource.includes('export function focusTerminalSession(agentId: string)') &&
      terminalPoolSource.includes('function focusAttachedTerminalInput(record: SessionRecord)') &&
      terminalPoolSource.includes('return focusTerminalInput(record.hostEl, record.terminal)') &&
      terminalPoolSource.includes('function focusTerminalInputWhenReady(\n  record: SessionRecord,\n  generation: number,') &&
      terminalPoolSource.includes('if (!isCurrentAttachment(record, generation)) return') &&
      terminalPoolSource.includes('focusTerminalInputWhenReady(record, generation, attemptsRemaining - 1)') &&
      terminalPoolSource.includes('focusTerminalInputWhenReady(record, generation)') &&
      terminalPoolSource.includes('focusAttachedTerminalInput(record)') &&
      !terminalPoolSource.includes('focusTerminalInput(record.hostEl, record.terminal)\n      }'),
    'terminal session focus should reuse the attached-owner guard and not focus parked or disposed terminal hosts'
  );
  assert(
      terminalOutputSource.includes('export function writeTerminalOutput') &&
      terminalOutputSource.includes('restoreUserScrollAfterWrite(record, previousViewportY, previousScrollbackLength)') &&
      terminalOutputSource.includes('const outputObserved = options.isOutputObserved?.() ?? true') &&
      terminalOutputSource.includes('} else if (!outputObserved) {') &&
      terminalOutputSource.includes('if (outputObserved) {') &&
      terminalOutputSource.includes('forceTerminalRender(record)') &&
      !terminalOutputSource.includes('if (quiet && !shouldFollowOutput)') &&
      terminalPoolSource.includes('isOutputObserved: () => isTerminalSessionAttached(record)') &&
      terminalPoolSource.includes('preserveUnreadOutputUntilJump: boolean') &&
      terminalPoolSource.includes("from '@/lib/terminal-viewport'") &&
      terminalViewportSource.includes('export function markTerminalOutputUnreadUntilJump') &&
      terminalViewportSource.includes('record.preserveUnreadOutputUntilJump = true') &&
      terminalOutputSource.includes('markTerminalOutputUnreadUntilJump(record)') &&
      terminalPoolSource.includes('allowClearUnread: true') &&
      terminalPoolSource.includes('if (record.disposed || !isTerminalSessionAttached(record)) return') &&
      terminalOutputSource.includes('export function restoreViewportAfterLayout') &&
      terminalPoolSource.includes('restoreViewportAfterLayout(record, previousViewportY, previousScrollbackLength, wasFollowing, hadUnreadOutput)') &&
      terminalPoolSource.includes('previousViewportY') &&
      terminalPoolSource.includes('previousScrollbackLength') &&
      terminalOutputSource.includes('restoredTerminalViewportY(record.terminal, previousViewportY, previousScrollbackLength)') &&
      terminalOutputSource.includes('scrollRecordToViewportY(record, targetLine)') &&
      terminalViewportSource.includes('export function setFollowOutputState') &&
      terminalViewportSource.includes('export function terminalPageScrollTarget'),
    'terminal session pool should preserve the user scrollback viewport when live output or layout changes arrive'
  );
  assert(
    terminalPoolSource.includes('function handleTerminalScrollKeyEvent') &&
      terminalPoolSource.includes("!['PageUp', 'PageDown'].includes(event.key)") &&
      terminalPoolSource.includes('if (terminal.attachCustomKeyEventHandler)') &&
      terminalPoolSource.includes('terminal.attachCustomKeyEventHandler((event: KeyboardEvent) =>') &&
      terminalPoolSource.includes('handleTerminalScrollKeyEvent(record, event) ? false : true') &&
      terminalPoolSource.includes('} else {') &&
      terminalPoolSource.includes("document.addEventListener('keydown', scrollKeyHandler, true)") &&
      terminalPoolSource.includes('terminal.onRender?.(() =>') &&
      terminalEngineSource.includes('attachCustomKeyEventHandler?: (handler: (event: KeyboardEvent) => boolean) => void') &&
      terminalEngineSource.includes('onRender?: (handler: () => void) => { dispose: () => void }') &&
      xtermSource.includes('attachCustomKeyEventHandler: (handler: (event: KeyboardEvent) => boolean) => void') &&
      xtermSource.includes('onRender: (handler: () => void) => { dispose: () => void }'),
    'terminal scroll keys should use xterm key/render hooks and keep the adapter contract explicit'
  );
  assert(
    terminalPoolSource.includes('writeSequenced') &&
      terminalPoolSource.includes('applyTerminalOutputEvent(record, text, false, outputSeq)'),
    'terminal regression tests should exercise reconnect/live-output races through the sequenced output state path'
  );
  assert(
    terminalPoolSource.includes('function installTerminalLinkProvider') &&
      terminalPoolSource.includes("from '@/lib/terminal-links'") &&
      terminalPoolSource.includes('const provider: TerminalLinkProvider =') &&
      terminalPoolSource.includes('record.terminal.registerLinkProvider(provider)') &&
      terminalPoolSource.includes('onPathResolve?: (agentId: string, target: TerminalPathOpenTarget)') &&
      terminalPoolSource.includes('pathResolveHandler:') &&
      terminalPoolSource.includes('pathResolveCache: Map<string') &&
      terminalPoolSource.includes('const TERMINAL_PATH_RESOLVE_CACHE_TTL_MS') &&
      terminalPoolSource.includes('function resolveTerminalPathTarget') &&
      terminalPoolSource.includes('function resolveTerminalLinkMatches') &&
      terminalPoolSource.includes('function cachedTerminalPathLink') &&
      terminalPoolSource.includes('function readTerminalPathLinkAtMouseEvent') &&
      terminalPoolSource.includes('void resolveTerminalPathLinkAtMouseEvent(record, event).then') &&
      terminalPoolSource.includes('const rawPathLink = record.pathOpenHandler ? readTerminalPathLinkAtMouseEvent(record, event) : null') &&
      pooledTerminalHookSource.includes('onPathResolve?: (agentId: string, target: TerminalPathOpenTarget)') &&
      pooledTerminalHookSource.includes('onPathResolve: handlePathResolve') &&
      terminalLinksSource.includes('export function collectTerminalLinkMatches') &&
      terminalLinksSource.includes('export function parseTerminalUrlAtColumn') &&
      terminalLinksSource.includes('export function parseTerminalPathLinkAtColumn') &&
      terminalLinksSource.includes('export function parseTerminalPathTargetAtColumn') &&
      terminalLinksSource.includes('export function terminalLinkMatchRange') &&
      terminalPoolSource.includes('function terminalOpenTargetKindAtMouseEvent') &&
      terminalPoolSource.includes('function refreshTerminalLinkHoverTarget') &&
      terminalPoolSource.includes('function isTerminalSessionAttached(record: SessionRecord)') &&
      terminalPoolSource.includes('function shouldHandleTerminalHoverEvent(record: SessionRecord)') &&
      terminalPoolSource.includes('if (!shouldHandleTerminalHoverEvent(record) || isMobileViewport())') &&
      terminalPoolSource.includes('const providerTarget = record.linkProviderHoverTarget') &&
      terminalPoolSource.includes("setTerminalLinkHoverTarget(record, providerTarget.kind === 'path' || active ? providerTarget.kind : null)") &&
      terminalPoolSource.includes('if (!shouldHandleTerminalHoverEvent(record)) {') &&
      terminalPoolSource.includes('clearTerminalOpenTargetState(record)') &&
      terminalPoolSource.includes('const modifierActive = isTerminalOpenModifierActive(record, event)') &&
      terminalPoolSource.includes('if (!isTerminalSessionAttached(record)) return') &&
      terminalPoolSource.includes('record.openModifierActive = isTerminalOpenModifierEvent(event)') &&
      terminalPoolSource.includes('refreshTerminalLinkHoverTarget(record, record.openModifierActive)') &&
      terminalPoolSource.includes("record.hostEl.classList.toggle('terminal-open-target-hover'") &&
      terminalPoolSource.includes("hostEl.addEventListener('mousemove', linkHoverHandler, true)") &&
      terminalPoolSource.includes("record.hostEl.removeEventListener('mousemove', record.linkHoverHandler, true)") &&
      terminalPoolSource.includes("window.addEventListener('keydown', linkHoverKeyHandler, true)") &&
      terminalPoolSource.includes("window.removeEventListener('keyup', record.linkHoverKeyHandler, true)") &&
      terminalPoolSource.includes('const pathDirectOpen = match.kind === \'path\' && Boolean(match.pathTarget && record.pathOpenHandler)') &&
      terminalPoolSource.includes('pointerCursor: pathDirectOpen') &&
      terminalPoolSource.includes('underline: pathDirectOpen') &&
      terminalPoolSource.includes("underline: pathDirectOpen || match.kind === 'url' || active") &&
      terminalPoolSource.includes('if (event.button !== 0) return') &&
      terminalPoolSource.includes("if (match.kind === 'url' && !modifierActive) return") &&
      terminalPoolSource.includes("if (match.kind === 'path' && !pathDirectOpen) return") &&
      terminalPoolSource.includes("setTerminalLinkHoverTarget(record, providerTarget.kind === 'path' || active ? providerTarget.kind : null)") &&
      terminalPoolSource.includes('openTargetMouseDown: { x: number; y: number; pathTarget: TerminalPathOpenTarget } | null') &&
      terminalPoolSource.includes('const mouseDownOpenTargetHandler = (event: MouseEvent) =>') &&
      terminalPoolSource.includes('const pathLink = record.pathOpenHandler ? readTerminalPathLinkAtMouseEvent(record, event) : null') &&
      terminalPoolSource.includes('record.openTargetMouseDown = {') &&
      terminalPoolSource.includes('pathTarget: pathLink.pathTarget') &&
      terminalPoolSource.includes('Math.hypot(event.clientX - mouseDown.x, event.clientY - mouseDown.y) > 4') &&
      terminalPoolSource.includes('void resolveTerminalPathTarget(record, mouseDown.pathTarget).then') &&
      terminalPoolSource.includes("hostEl.addEventListener('mouseup', mouseUpOpenTargetHandler, true)") &&
      terminalPoolSource.includes("record.hostEl.removeEventListener('mouseup', record.mouseUpOpenTargetHandler, true)") &&
      terminalEngineSource.includes('registerLinkProvider?: (linkProvider: TerminalLinkProvider) => { dispose: () => void }') &&
      xtermSource.includes("registerLinkProvider: Terminal['registerLinkProvider']") &&
      mainCssSource.includes('.terminal-session-host.terminal-open-target-hover .xterm'),
    'terminal URL/path targets should use xterm link providers with direct high-confidence file links and modifier-protected URL links'
  );
  assert(
    terminalOutputSource.includes('function writeTerminalData') &&
      !terminalPoolSource.includes('record.terminal.scrollToBottom = () => {}') &&
      terminalOutputSource.includes('record.terminal.write(data, callback)') &&
      terminalOutputSource.includes('writeTerminalData(record, data') &&
      terminalOutputSource.includes('restoreUserScrollAfterWrite(record, previousViewportY, previousScrollbackLength)') &&
      terminalPoolSource.includes('writeRawAndSampleViewport'),
    'terminal session pool should preserve paused viewport without monkey-patching terminal scroll methods'
  );
  const writeTerminalOutputBody = terminalOutputSource.match(/export function writeTerminalOutput[\s\S]*?\n}\n\nexport function replaceTerminalOutput/)?.[0] || '';
  assert(
    writeTerminalOutputBody.includes('writeTerminalData(record, data') &&
      !writeTerminalOutputBody.includes('scheduleTerminalRepaint(record)') &&
      terminalOutputSource.includes('export function scheduleTerminalRepaint'),
    'terminal live output should rely on ghostty rendering instead of forcing repeated repaint on every output chunk'
  );

  const ghosttySource = fs.readFileSync(path.join(__dirname, '../../src/lib/ghostty.ts'), 'utf8');
  assert(
    ghosttySource.includes('export const DEFAULT_FONT_SIZE = 13'),
    'ghostty terminal font size should match the tighter Codex desktop terminal feel'
  );
  assert(
    ghosttySource.includes('scrollback: 5000') &&
      !ghosttySource.includes('scrollback: 20000'),
    'ghostty terminal scrollback should stay bounded for web performance'
  );

  const localSessionEngineSource = fs.readFileSync(path.join(__dirname, '../../backend/local-session-engine.js'), 'utf8');
  assert(
    localSessionEngineSource.includes('previewSnapshot: false'),
    'local session preview workers should avoid styled cell snapshots on the Codex web hot path'
  );

  const serverSource = fs.readFileSync(path.join(__dirname, '../../backend/server.js'), 'utf8');
  assert(
    serverSource.includes('const PREVIEW_BROADCAST_INTERVAL_MS = 500') &&
      serverSource.includes('function schedulePreviewBroadcast(preview)') &&
      serverSource.includes('pendingPreviewBroadcasts.set(agentId, entry)') &&
      serverSource.includes('schedulePreviewBroadcast(preview)'),
    'server should coalesce terminal preview broadcasts so live output does not flood the UI'
  );
  assert(
      serverSource.includes('const pendingResumeStarts = new Map()') &&
      serverSource.includes('function resumedAgentStartKey') &&
      serverSource.includes('const pendingStart = pendingResumeStarts.get(pendingResumeId)') &&
      serverSource.includes('reused: true') &&
      serverSource.includes('pending: true') &&
      serverSource.includes('result.claimed ? { claimed: true } : {}') &&
      serverSource.includes('pendingResumeStarts.delete(pendingResumeId)'),
    'server should serialize duplicate resume requests for the same agent session'
  );

  const agentManagerSource = fs.readFileSync(path.join(__dirname, '../../backend/agent-manager.js'), 'utf8');
  const startAgentBody = agentManagerSource.slice(
    agentManagerSource.indexOf('async startAgent'),
    agentManagerSource.indexOf('async sendInput')
  );
  assert(
    startAgentBody.includes("agent.status = 'running'") &&
      !startAgentBody.includes('setTimeout(() =>'),
    'AgentManager should mark started sessions running immediately instead of waiting on a fixed timer'
  );

  const appSource = fs.readFileSync(path.join(__dirname, '../../src/App.tsx'), 'utf8');
  assert(
    appSource.includes('destroyTerminalSession(agentId)') &&
      appSource.includes('Failed to destroy killed terminal session'),
    'killing an agent should immediately destroy its pooled terminal session'
  );
  assert(
    appSource.includes('if (pendingStartRef.current) return') &&
      appSource.includes('if (!ws.startAgent(command, workspace, false, extras))') &&
      appSource.includes('pendingStartRef.current = null'),
    'Start Agent should ignore duplicate clicks while a start request is already pending'
  );

  const legacyAppSource = fs.readFileSync(path.join(__dirname, '../../frontend/app.js'), 'utf8');
  assert(
    legacyAppSource.includes('function normalizeTerminalSelectionText'),
    'legacy session modal should normalize soft-wrapped terminal selections'
  );
  assert(
    legacyAppSource.includes("document.addEventListener('copy'"),
    'legacy session modal should also force terminal copy events to text/plain'
  );

  const e2eSource = fs.readFileSync(path.join(__dirname, '../../scripts/e2e.js'), 'utf8');
  assert(
    e2eSource.includes('wrapped long URL selection should copy as one unbroken URL'),
    'E2E should cover long URL selection across terminal soft wraps'
  );
  assert(
    e2eSource.includes('CJK selection should copy without inserted spaces between Chinese characters'),
    'E2E should cover Chinese wide-character selection without inserted spaces'
  );
  assert(
    e2eSource.includes('IME composition text should match the terminal font size') &&
      e2eSource.includes('IME composition should not mutate terminal protocol cursor visibility') &&
      e2eSource.includes('IME keydown 229 should hide the green block cursor before composition text updates') &&
      e2eSource.includes('IME composition should repaint the canvas so the green block cursor disappears visually') &&
      e2eSource.includes('IME composition should keep the green block cursor hidden after TUI output tries to redraw it') &&
      e2eSource.includes('IME composition should preserve a terminal cursor that was already hidden'),
    'E2E should cover IME overlay font size and visual cursor hiding'
  );
  assert(
    e2eSource.includes('live terminal copy should write the normalized terminal selection to text/plain') &&
      e2eSource.includes('dispatchCopyFromTextarea') &&
      e2eSource.includes('double-click should select one continuous non-whitespace terminal token'),
    'E2E should cover real session modal copy and double-click selection'
  );
  assert(
    e2eSource.includes('Ghostty cell width should preserve fractional font metrics'),
    'E2E should cover Ghostty-like fractional cell metrics for CJK display width'
  );
  assert(
    e2eSource.includes('terminal host should belong to the opened agent'),
    'E2E should verify session modal terminal host ownership'
  );
  assert(
    e2eSource.includes('removed after modal kill') &&
      e2eSource.includes('terminal-session-host[data-agent-id='),
    'E2E should verify killed terminal hosts are removed before opening another agent'
  );

  const ghosttyWebSource = fs.readFileSync(
    path.join(__dirname, '../../frontend/vendor/ghostty-web/ghostty-web.js'),
    'utf8'
  );
  assert(
    !ghosttyWebSource.includes('E = Math.ceil(g.width)'),
    'ghostty-web renderer should not widen cells by ceiling measured M width'
  );

  Object.defineProperty(global, 'navigator', {
    value: originalNavigator,
    configurable: true,
  });

  console.log('test-session-input-helpers passed');
}

run();
