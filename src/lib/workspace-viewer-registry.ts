export type WorkspaceFileViewerId = 'html.preview' | 'markdown.preview' | 'svg.preview'

export interface WorkspaceFileViewerContribution {
  id: WorkspaceFileViewerId
  extensions: readonly string[]
  renderMode: 'native' | 'sandbox'
}

const BUILTIN_WORKSPACE_FILE_VIEWERS: readonly WorkspaceFileViewerContribution[] = [
  {
    id: 'markdown.preview',
    extensions: ['.md', '.markdown', '.mdown', '.mkd'],
    renderMode: 'native',
  },
  {
    id: 'svg.preview',
    extensions: ['.svg'],
    renderMode: 'native',
  },
  {
    id: 'html.preview',
    extensions: ['.html', '.htm'],
    renderMode: 'sandbox',
  },
]

function fileExtension(filePath: string) {
  const basename = filePath.split('/').filter(Boolean).pop()?.toLowerCase() || ''
  const dotIndex = basename.lastIndexOf('.')
  return dotIndex > 0 ? basename.slice(dotIndex) : ''
}

export function workspaceFileViewerContributions(filePath: string) {
  const extension = fileExtension(filePath)
  return BUILTIN_WORKSPACE_FILE_VIEWERS.filter(viewer => viewer.extensions.includes(extension))
}

export function workspaceFileSupportsViewer(filePath: string, viewerId: WorkspaceFileViewerId) {
  return workspaceFileViewerContributions(filePath).some(viewer => viewer.id === viewerId)
}
