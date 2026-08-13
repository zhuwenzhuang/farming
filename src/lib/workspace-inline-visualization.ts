import { buildWorkspacePreviewDocument } from './workspace-preview-document'

export function buildWorkspaceInlineVisualizationDocument(source: string, baseUrl: string, rootUrl: string) {
  return buildWorkspacePreviewDocument(source, baseUrl, rootUrl, true)
}
