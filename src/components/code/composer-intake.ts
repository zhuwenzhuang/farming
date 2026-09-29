import { appPath } from '@/lib/base-path'
import type { AgentComposerState } from './composer-state'
import { createComposerAttachmentId, createImageAttachmentPreviewUrl, isAudioFile, isImageFile, uploadImageAttachment, type ComposerAttachment } from './composer-message'
import { readComposerInputPreferences } from './composer-input-preferences'

const queued: Array<() => void> = []
let running = 0
function scheduleIntake(task: () => Promise<void>) {
  const run = () => {
    running++
    void task().finally(() => { running--; queued.shift()?.() })
  }
  if (running < 2) run()
  else queued.push(run)
}
const pending = new Map<string, AbortController>()
export function cancelComposerIntake(id: string) { pending.get(id)?.abort(); pending.delete(id) }
export function attachmentPreviewUrl(path?: string) {
  if (!path) return undefined
  const name = path.split(/[\\/]/).pop()
  return name?.startsWith('pasted-') ? appPath(`/api/attachments/${encodeURIComponent(name)}`) : undefined
}
const mimeByExtension: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', webm: 'audio/webm',
}
export function normalizeAttachmentMime(file: File) {
  const type = mimeByExtension[file.name.split('.').pop()?.toLowerCase() || '']
  return type && (!file.type || file.type === 'application/octet-stream') ? new File([file], file.name, { type }) : file
}
async function prepareImage(file: File, signal: AbortSignal) {
  if (file.size > 25 * 1024 * 1024) throw new Error('Image exceeds 25 MB. Resize it before attaching.')
  let prepared = file
  if (/^image\/hei[cf]$/.test(file.type)) {
    const blob = await new Promise<Blob>((resolve, reject) => {
      const worker = new Worker(new URL('./composer-heic.worker.ts', import.meta.url), { type: 'module' })
      const finish = (error?: Error, blob?: Blob) => {
        worker.terminate(); signal.removeEventListener('abort', cancel)
        if (error) reject(error)
        else if (blob) resolve(blob)
      }
      const cancel = () => finish(new Error('Image conversion interrupted.'))
      signal.addEventListener('abort', cancel, { once: true })
      worker.onerror = () => finish(new Error('HEIC conversion failed. Export the image as PNG or JPEG.'))
      worker.onmessage = (event: MessageEvent<{ blob?: Blob; error?: string }>) => finish(event.data.error ? new Error(event.data.error) : undefined, event.data.blob)
      worker.postMessage(file)
      if (signal.aborted) cancel()
    })
    prepared = new File([blob], file.name.replace(/\.[^.]+$/, '') + '.png', { type: 'image/png' })
  }
  signal.throwIfAborted()
  if (readComposerInputPreferences().optimizeImages && ['image/png', 'image/jpeg', 'image/webp'].includes(prepared.type)) {
    const bitmap = await createImageBitmap(prepared)
    try {
      const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Image conversion is unavailable in this browser.')
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error('Image conversion failed.')), 'image/webp', 0.85))
      if (blob.size < prepared.size) prepared = new File([blob], file.name.replace(/\.[^.]+$/, '') + '.webp', { type: 'image/webp' })
    } finally { bitmap.close() }
  }
  if (prepared.size > 12 * 1024 * 1024) throw new Error('Image exceeds 12 MB. Enable image optimization or resize it before attaching.')
  return prepared
}

type Update = (fn: (state: AgentComposerState) => AgentComposerState) => void
/** Reserve identity synchronously; completion can only update an existing item. */
export function intakeComposerFile(raw: File, update: Update, updateExisting: Update) {
  const file = normalizeAttachmentMime(raw)
  const id = createComposerAttachmentId(file)
  const media = isImageFile(file) || isAudioFile(file)
  const controller = new AbortController()
  pending.set(id, controller)
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)])
  const initial: ComposerAttachment = { id, kind: isAudioFile(file) ? 'audio' : 'image', name: file.name || 'Pasted image', type: file.type, size: file.size, status: 'uploading' }
  update(state => {
    return media ? { ...state, attachments: [...state.attachments, initial] }
      : { ...state, contextReferences: [...(state.contextReferences || []), { id, kind: 'document', label: file.name, status: 'uploading', type: file.type, size: file.size }] }
  })
  scheduleIntake(async () => {
    try {
      signal.throwIfAborted()
      if (media) {
        const prepared = isImageFile(file) ? await prepareImage(file, signal) : file
        if (prepared.size > 25 * 1024 * 1024) throw new Error('Audio exceeds 25 MB. Split it before attaching.')
        signal.throwIfAborted()
        const previewUrl = isImageFile(prepared) ? createImageAttachmentPreviewUrl(prepared) : undefined
        updateExisting(state => ({ ...state, attachments: state.attachments.map(item => item.id === id ? { ...item, previewUrl } : item) }))
        try {
          const uploaded = await uploadImageAttachment(prepared, signal)
          updateExisting(state => ({ ...state, attachments: state.attachments.map(item => item.id === id ? { ...item, ...uploaded, name: prepared.name, status: 'ready', previewUrl: attachmentPreviewUrl(uploaded.path) } : item) }))
        } finally { if (previewUrl) URL.revokeObjectURL(previewUrl) }
      } else {
        if (!file.size || file.size > 20 * 1024 * 1024) throw new Error('Attach a non-empty document smaller than 20 MB.')
        const response = await fetch(appPath(`/api/attachments/document?name=${encodeURIComponent(file.name)}`), {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file, signal,
        })
        const result = await response.json() as { text?: string; path?: string; type?: string; error?: string }
        if (!response.ok || typeof result.text !== 'string' || typeof result.path !== 'string' || !result.path || !result.text.trim()) throw new Error(result.error || `Document upload failed (${response.status}).`)
        updateExisting(state => {
          const totalText = (state.contextReferences || []).reduce((sum, item) => sum + (item.text?.length || 0), result.text!.length)
          return { ...state, contextReferences: state.contextReferences?.map(item => item.id === id
            ? totalText > 250_000 ? { ...item, path: result.path, status: 'error', error: 'Combined document text exceeds 250,000 characters. Split the message before attaching more documents.' }
              : { ...item, text: result.text, path: result.path, type: result.type, status: 'ready' }
            : item) }
        })
      }
    } catch (caught) {
      const error = signal.aborted ? 'Attachment interrupted. Remove it and attach it again.' : caught instanceof Error ? caught.message : 'Attachment failed.'
      updateExisting(state => media ? { ...state, attachments: state.attachments.map(item => item.id === id ? { ...item, status: 'error', error, previewUrl: undefined } : item) }
        : { ...state, contextReferences: state.contextReferences?.map(item => item.id === id ? { ...item, status: 'error', error } : item) })
    } finally { pending.delete(id) }
  })
}
