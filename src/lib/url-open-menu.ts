import { writeClipboardText } from '@/lib/clipboard'

let activeMenuCleanup: (() => void) | null = null

function urlMenuCopy() {
  const language = document.documentElement.lang || navigator.language || ''
  const zh = language.toLowerCase().startsWith('zh')
  return {
    farming: zh ? '在 Farming 浏览器中打开' : 'Open in Farming browser',
    external: zh ? '在外部浏览器中打开' : 'Open in external browser',
    copy: zh ? '复制链接' : 'Copy link',
  }
}

function clampUrlMenuPosition(x: number, y: number) {
  const margin = 8
  const width = 220
  const height = 110
  return {
    x: Math.max(margin, Math.min(x, window.innerWidth - width - margin)),
    y: Math.max(margin, Math.min(y, window.innerHeight - height - margin)),
  }
}

function createUrlMenuItem(label: string, onClick: () => void, disabled = false) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'terminal-context-menu-item'
  button.setAttribute('role', 'menuitem')
  button.textContent = label
  button.disabled = disabled
  button.addEventListener('click', () => {
    if (!button.disabled) onClick()
  })
  return button
}

function isKeyboardContextMenuEvent(event: MouseEvent) {
  return event.button === 0 && !('pointerType' in event)
}

export function openExternalUrl(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer')
}

export function showUrlOpenMenu({
  event,
  url,
  onOpenInFarming,
}: {
  event: MouseEvent
  url: string
  onOpenInFarming?: () => void
}) {
  event.preventDefault()
  event.stopPropagation()
  event.stopImmediatePropagation()
  activeMenuCleanup?.()

  const copy = urlMenuCopy()
  const position = clampUrlMenuPosition(event.clientX, event.clientY)
  const menu = document.createElement('div')
  menu.className = 'terminal-context-menu terminal-context-menu-pooled'
  menu.dataset.testid = 'code-url-context-menu'
  menu.setAttribute('role', 'menu')
  menu.style.left = `${position.x}px`
  menu.style.top = `${position.y}px`

  const cleanup = () => {
    document.removeEventListener('mousedown', closeOnOutsidePointer, true)
    document.removeEventListener('pointerdown', closeOnOutsidePointer, true)
    document.removeEventListener('keydown', closeOnKeydown, true)
    window.removeEventListener('resize', cleanup)
    window.removeEventListener('scroll', cleanup, true)
    menu.remove()
    if (activeMenuCleanup === cleanup) activeMenuCleanup = null
  }
  const run = (action: () => void) => {
    cleanup()
    action()
  }
  const closeOnOutsidePointer = (pointerEvent: MouseEvent | PointerEvent) => {
    if (pointerEvent.target instanceof Node && menu.contains(pointerEvent.target)) return
    cleanup()
  }
  const closeOnKeydown = (keyboardEvent: KeyboardEvent) => {
    if (keyboardEvent.key !== 'Escape') return
    keyboardEvent.preventDefault()
    cleanup()
  }

  if (onOpenInFarming) {
    menu.append(createUrlMenuItem(copy.farming, () => run(onOpenInFarming)))
  }
  menu.append(
    createUrlMenuItem(copy.external, () => run(() => openExternalUrl(url))),
    createUrlMenuItem(copy.copy, () => run(() => {
      void writeClipboardText(url)
    })),
  )
  menu.addEventListener('mousedown', menuEvent => menuEvent.stopPropagation())
  menu.addEventListener('pointerdown', menuEvent => menuEvent.stopPropagation())
  document.body.appendChild(menu)
  activeMenuCleanup = cleanup

  document.addEventListener('mousedown', closeOnOutsidePointer, true)
  document.addEventListener('pointerdown', closeOnOutsidePointer, true)
  document.addEventListener('keydown', closeOnKeydown, true)
  window.addEventListener('resize', cleanup)
  window.addEventListener('scroll', cleanup, true)
  if (isKeyboardContextMenuEvent(event)) {
    requestAnimationFrame(() => menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus())
  }
}
