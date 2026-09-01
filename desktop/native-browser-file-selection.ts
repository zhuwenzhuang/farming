type NativeBrowserFileInput = {
  tagName?: string
  type?: string
  value?: string
}

type NativeBrowserEventTarget = {
  closest?: (selector: string) => unknown
  control?: unknown
}

type NativeBrowserFileSelectionEvent = {
  dataTransfer?: {
    files?: {
      length?: number
    }
  } | null
  key?: string
  preventDefault: () => void
  stopImmediatePropagation: () => void
  target?: unknown
}

type NativeBrowserGuardDocument = {
  addEventListener: (
    type: string,
    listener: (event: NativeBrowserFileSelectionEvent) => void,
    capture: boolean,
  ) => void
}

const FILE_INPUT_SELECTOR = 'input[type="file"]'
const FILE_SELECTION_BLOCKED_MESSAGE = 'FARMING_NATIVE_BROWSER_FILE_SELECTION_BLOCKED'
const installedDocuments = new WeakSet<object>()

function fileInputFromTarget(target: unknown): NativeBrowserFileInput | null {
  if (!target || typeof target !== 'object') return null
  const candidate = target as NativeBrowserEventTarget
  const direct = candidate.closest?.(FILE_INPUT_SELECTOR)
  if (direct && typeof direct === 'object') return direct as NativeBrowserFileInput
  const label = candidate.closest?.('label')
  if (!label || typeof label !== 'object') return null
  const control = (label as NativeBrowserEventTarget).control
  if (
    !control
    || typeof control !== 'object'
    || String((control as NativeBrowserFileInput).tagName || '').toLowerCase() !== 'input'
    || String((control as NativeBrowserFileInput).type || '').toLowerCase() !== 'file'
  ) return null
  return control as NativeBrowserFileInput
}

export function installNativeBrowserFileSelectionGuard(
  documentValue: NativeBrowserGuardDocument,
  reportBlocked: () => void = () => console.warn(FILE_SELECTION_BLOCKED_MESSAGE),
): void {
  if (installedDocuments.has(documentValue as object)) return
  installedDocuments.add(documentValue as object)
  const block = (event: NativeBrowserFileSelectionEvent) => {
    event.preventDefault()
    event.stopImmediatePropagation()
    reportBlocked()
  }
  const blockActivation = (event: NativeBrowserFileSelectionEvent) => {
    if (fileInputFromTarget(event.target)) block(event)
  }
  const clearSelection = (event: NativeBrowserFileSelectionEvent) => {
    const input = fileInputFromTarget(event.target)
    if (!input) return
    try {
      input.value = ''
    } finally {
      block(event)
    }
  }
  documentValue.addEventListener('click', blockActivation, true)
  documentValue.addEventListener('auxclick', blockActivation, true)
  documentValue.addEventListener('pointerdown', blockActivation, true)
  documentValue.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') blockActivation(event)
  }, true)
  documentValue.addEventListener('input', clearSelection, true)
  documentValue.addEventListener('change', clearSelection, true)
  documentValue.addEventListener('drop', event => {
    if (Number(event.dataTransfer?.files?.length || 0) > 0) block(event)
  }, true)
}
