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

export function buildWorkspaceHtmlPreviewDocument(source: string, baseUrl: string, rootUrl: string) {
  const safeBaseUrl = escapeHtmlAttribute(baseUrl)
  const safeRootUrl = escapeHtmlAttribute(rootUrl)
  const policy = [
    "default-src 'none'",
    "script-src 'none'",
    `style-src ${safeBaseUrl} ${safeRootUrl} 'unsafe-inline'`,
    `img-src ${safeBaseUrl} ${safeRootUrl} data:`,
    `font-src ${safeBaseUrl} ${safeRootUrl} data:`,
    `media-src ${safeBaseUrl} ${safeRootUrl} data:`,
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
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
