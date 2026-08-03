function escapeHtmlAttribute(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function rewriteRootRelativeReferences(source: string, rootUrl: string) {
  return source
    .replace(/(\b(?:href|src|poster)\s*=\s*["'])\/(?!\/)/gi, `$1${rootUrl}`)
    .replace(/(url\(\s*["']?)\/(?!\/)/gi, `$1${rootUrl}`)
}

export function workspaceHtmlPreviewRefreshDelay(expiresAt: number, now = Date.now()) {
  return Math.max(1_000, expiresAt - now - 60_000)
}

function buildWorkspacePreviewDocument(source: string, baseUrl: string, rootUrl: string, inlineVisualization: boolean) {
  const safeBaseUrl = escapeHtmlAttribute(baseUrl)
  const safeRootUrl = escapeHtmlAttribute(rootUrl)
  const visualizationCdn = 'https://cdnjs.cloudflare.com https://esm.sh https://cdn.jsdelivr.net https://unpkg.com https://fonts.googleapis.com https://fonts.gstatic.com https://fonts.bunny.net'
  const policy = [
    "default-src 'none'",
    inlineVisualization
      ? `script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: data: ${visualizationCdn}`
      : "script-src 'none'",
    `style-src ${safeBaseUrl} ${safeRootUrl} 'unsafe-inline' blob: data:${inlineVisualization ? ` ${visualizationCdn}` : ''}`,
    `img-src ${safeBaseUrl} ${safeRootUrl} blob: data:${inlineVisualization ? ` ${visualizationCdn}` : ''}`,
    `font-src ${safeBaseUrl} ${safeRootUrl} blob: data:${inlineVisualization ? ` ${visualizationCdn}` : ''}`,
    `media-src ${safeBaseUrl} ${safeRootUrl} blob: data:`,
    inlineVisualization ? 'worker-src blob:' : "worker-src 'none'",
    inlineVisualization ? 'connect-src blob: data:' : "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    `base-uri ${safeBaseUrl}`,
    "form-action 'none'",
  ].join('; ')
  const headContent = [
    `<meta http-equiv="Content-Security-Policy" content="${policy}">`,
    `<base href="${safeBaseUrl}">`,
  ].join('')
  const rewritten = rewriteRootRelativeReferences(String(source || ''), safeRootUrl)

  if (/<head\b[^>]*>/i.test(rewritten)) {
    return rewritten.replace(/<head\b[^>]*>/i, match => `${match}${headContent}`)
  }
  if (/<html\b[^>]*>/i.test(rewritten)) {
    return rewritten.replace(/<html\b[^>]*>/i, match => `${match}<head>${headContent}</head>`)
  }
  return `<head>${headContent}</head>${rewritten}`
}

export function buildWorkspaceHtmlPreviewDocument(source: string, baseUrl: string, rootUrl: string) {
  return buildWorkspacePreviewDocument(source, baseUrl, rootUrl, false)
}

export function buildWorkspaceInlineVisualizationDocument(source: string, baseUrl: string, rootUrl: string) {
  return buildWorkspacePreviewDocument(source, baseUrl, rootUrl, true)
}
