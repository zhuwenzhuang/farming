import { buildWorkspacePreviewDocument } from './workspace-preview-document'
import { visualizationBridge, visualizationStyles } from './visualization-runtime'

export function buildWorkspaceInlineVisualizationDocument(source: string, baseUrl: string, rootUrl: string, channel = '', theme?: { tokens: Record<string, string>; colorScheme: string }, icons = '') {
  const fragment = !/<(?:!doctype|html|head|body)\b/i.test(source)
  const documentSource = fragment ? `<!doctype html><html><head></head><body>${source}</body></html>` : source
  const document = buildWorkspacePreviewDocument(documentSource, baseUrl, rootUrl, true)
  const tokens = Object.entries(theme?.tokens || {}).map(([key, value]) => `--${key}:${value}`).join(';')
  const styles = `<style>:root{${tokens}}${fragment ? visualizationStyles : ''}</style>`
  const bridgeSource = `(${visualizationBridge.toString()})(${JSON.stringify(channel)},${fragment})`.replace(/<\/script/gi, '<\\/script')
  const bridge = `<script>${fragment ? icons.replace(/<\/script/gi, '<\\/script') : ''}\n${bridgeSource}</script>`
  return document.replace(/<base\b[^>]*>/i, match => `${match}${styles}${bridge}`)
}
