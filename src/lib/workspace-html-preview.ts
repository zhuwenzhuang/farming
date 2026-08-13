import { buildWorkspacePreviewDocument } from './workspace-preview-document'

export function workspaceHtmlPreviewRefreshDelay(expiresAt: number, now = Date.now()) {
  return Math.max(1_000, expiresAt - now - 60_000)
}

export function buildWorkspaceHtmlPreviewDocument(source: string, baseUrl: string, rootUrl: string) {
  return buildWorkspacePreviewDocument(source, baseUrl, rootUrl, false)
}
