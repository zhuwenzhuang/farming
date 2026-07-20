import type { ComposerMode } from './types'

const MAX_ATTACHED_FILE_CHARS = 50_000

const COMPOSER_MODE_INSTRUCTIONS: Record<Exclude<ComposerMode, 'default'>, string> = {
  goal: 'Goal mode: Treat the following as the working goal for this agent. Track progress toward it and report clearly when it is complete or blocked.',
  plan: 'Plan mode: Inspect the relevant context first and respond with a concise plan before making code changes. Do not edit files until the plan is clear.',
}

function normalizeBasePath(baseUrl: string) {
  if (!baseUrl || baseUrl === '/') return ''
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
}

function composerAppPath(path = '/') {
  const rawBaseUrl = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL || '/'
  const basePath = normalizeBasePath(rawBaseUrl)
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return basePath ? `${basePath}${normalizedPath}` : normalizedPath
}

export interface UploadedImageAttachment {
  path: string
  name: string
  type: string
  size: number
}

export interface ComposerAttachment {
  id: string
  kind: 'image'
  name: string
  type: string
  size: number
  status: 'uploading' | 'ready' | 'error'
  previewUrl?: string
  path?: string
  messageBlock?: string
  error?: string
}

export interface ComposerPromptAttachment {
  kind: 'image'
  path: string
  name: string
  type: string
  size: number
}

export function appendDraftBlock(current: string, block: string) {
  const nextBlock = block.trimEnd()
  if (!nextBlock) return current
  const separator = current.trim() ? '\n\n' : ''
  return `${current.trimEnd()}${separator}${nextBlock}`
}

export function fileDisplayName(file: File, fallback = 'attachment') {
  return file.name || fallback
}

export function isImageFile(file: File) {
  return typeof file.type === 'string' && file.type.startsWith('image/')
}

export function formatAttachedFile(file: File, content: string) {
  const truncated = content.length > MAX_ATTACHED_FILE_CHARS
  const body = truncated ? content.slice(0, MAX_ATTACHED_FILE_CHARS) : content
  const suffix = truncated ? `\n\n[File truncated after ${MAX_ATTACHED_FILE_CHARS} characters]` : ''
  return `Attached file: ${fileDisplayName(file)}\n\n${body}${suffix}`
}

export function formatAttachedImage(attachment: UploadedImageAttachment) {
  return `Attached image: ${attachment.name}\n\nImage path: ${attachment.path}`
}

export function createComposerAttachmentId(file: File) {
  const suffix = Math.random().toString(36).slice(2, 8)
  return `image-${Date.now()}-${fileDisplayName(file, 'pasted-image')}-${suffix}`
}

export function createImageAttachmentPreviewUrl(file: File) {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return undefined
  return URL.createObjectURL(file)
}

export function revokeComposerAttachmentPreview(attachment: ComposerAttachment) {
  if (!attachment.previewUrl || typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return
  URL.revokeObjectURL(attachment.previewUrl)
}

export function composerAttachmentMessageBlocks(attachments: ComposerAttachment[]) {
  return attachments
    .map(attachment => attachment.messageBlock || '')
    .filter(Boolean)
}

export function composerMessageWithAttachments(draft: string, attachments: ComposerAttachment[]) {
  const attachmentBlocks = composerAttachmentMessageBlocks(attachments)
  return appendDraftBlock(draft.trimEnd(), attachmentBlocks.join('\n\n')).trimEnd()
}

export function composerMessageForNativeAttachments(draft: string, attachments: ComposerAttachment[]) {
  const fallbackBlocks = attachments
    .filter(attachment => !attachment.path)
    .map(attachment => attachment.messageBlock || '')
    .filter(Boolean)
  return appendDraftBlock(draft.trimEnd(), fallbackBlocks.join('\n\n')).trimEnd()
}

export function composerPromptAttachments(attachments: ComposerAttachment[]): ComposerPromptAttachment[] {
  return attachments.flatMap(attachment => attachment.status === 'ready' && attachment.path
    ? [{
        kind: 'image' as const,
        path: attachment.path,
        name: attachment.name,
        type: attachment.type,
        size: attachment.size,
      }]
    : [])
}

export function readFileText(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('File read failed'))
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.readAsText(file)
  })
}

export async function uploadImageAttachment(file: File): Promise<UploadedImageAttachment> {
  const response = await fetch(composerAppPath('/api/attachments/image'), {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'image/png',
    },
    body: file,
  })

  if (!response.ok) {
    throw new Error(`Image upload failed: ${response.status}`)
  }

  return response.json()
}

export async function formatAttachmentFile(file: File) {
  if (isImageFile(file)) {
    return formatAttachedImage(await uploadImageAttachment(file))
  }

  try {
    return formatAttachedFile(file, await readFileText(file))
  } catch {
    return `Attached file: ${fileDisplayName(file)}\n\n[Unable to read this file as text]`
  }
}

export function formatAttachmentError(file: File) {
  if (isImageFile(file)) {
    return `Attached image: ${fileDisplayName(file, 'pasted image')}\n\n[Unable to upload this image]`
  }

  return `Attached file: ${fileDisplayName(file)}\n\n[Unable to read this file as text]`
}

export function clipboardImageFiles(data: DataTransfer | null) {
  if (!data) return []

  const files = Array.from(data.files ?? []).filter(isImageFile)
  if (files.length > 0) return files

  return Array.from(data.items ?? [])
    .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
    .map(item => item.getAsFile())
    .filter((file): file is File => Boolean(file && isImageFile(file)))
}

export function formatComposerMessage(mode: ComposerMode, text: string) {
  if (mode === 'default') return text
  return `${COMPOSER_MODE_INSTRUCTIONS[mode]}\n\n${text}`
}
