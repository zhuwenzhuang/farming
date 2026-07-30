export const DEFAULT_CODE_CONTENT_FONT_SIZE = 14
export const DEFAULT_CRT_CONTENT_FONT_SIZE = 14
export const MIN_CONTENT_FONT_SIZE = 10
export const MAX_CONTENT_FONT_SIZE = 20

export function normalizeContentFontSize(
  value: unknown,
  fallback = DEFAULT_CODE_CONTENT_FONT_SIZE,
) {
  const fontSize = Number(value)
  if (!Number.isFinite(fontSize)) return fallback
  return Math.min(MAX_CONTENT_FONT_SIZE, Math.max(MIN_CONTENT_FONT_SIZE, Math.round(fontSize)))
}

export function codeEditorFontSize(contentFontSize: unknown) {
  return Math.max(MIN_CONTENT_FONT_SIZE, normalizeContentFontSize(contentFontSize) - 1)
}

export function codeEditorLineHeight(contentFontSize: unknown) {
  return codeEditorFontSize(contentFontSize) + 8
}

export function codeTerminalFontSize(contentFontSize: unknown, compact = false) {
  const offset = compact ? 3 : 2
  return Math.max(MIN_CONTENT_FONT_SIZE, normalizeContentFontSize(contentFontSize) - offset)
}

export function crtTerminalFontSize(contentFontSize: unknown) {
  return Math.min(MAX_CONTENT_FONT_SIZE, normalizeContentFontSize(
    contentFontSize,
    DEFAULT_CRT_CONTENT_FONT_SIZE,
  ) + 1)
}

export function readCodeContentFontSize() {
  if (typeof document === 'undefined') return DEFAULT_CODE_CONTENT_FONT_SIZE
  return normalizeContentFontSize(document.body.dataset.codeContentFontSize)
}

export function applyCodeContentFontSize(value: unknown) {
  const contentFontSize = normalizeContentFontSize(value)
  if (typeof document === 'undefined') return contentFontSize
  document.body.dataset.codeContentFontSize = String(contentFontSize)
  document.body.style.setProperty('--code-content-font-size', `${contentFontSize}px`)
  document.body.style.setProperty('--code-content-line-height', `${contentFontSize + 6}px`)
  document.body.style.setProperty('--code-editor-font-size', `${codeEditorFontSize(contentFontSize)}px`)
  document.body.style.setProperty('--code-editor-line-height', `${codeEditorLineHeight(contentFontSize)}px`)
  return contentFontSize
}
