import { heicTo } from 'heic-to/csp'
self.onmessage = async (event: MessageEvent<File>) => {
  let bitmap: ImageBitmap | undefined
  try {
    bitmap = await heicTo({ blob: event.data, type: 'bitmap' })
    if (bitmap.width * bitmap.height > 40_000_000) throw new Error('HEIC image exceeds 40 megapixels. Resize it before attaching.')
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Image conversion is unavailable in this browser.')
    context.drawImage(bitmap, 0, 0)
    self.postMessage({ blob: await canvas.convertToBlob({ type: 'image/png' }) })
  } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }) }
  finally { bitmap?.close() }
}
