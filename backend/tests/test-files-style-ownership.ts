import { assertDomainStyleOwnership } from './style-ownership-contract'

assertDomainStyleOwnership({
  domain: 'files',
  prefixes: ['code-file', 'code-files', 'code-open'],
  // The File Editor pane owns its own extracted namespaces.
  excludePrefixes: [
    'code-file-editor',
    'code-file-monaco',
    'code-file-preview-panel',
    'code-file-diff',
    'code-file-html-preview',
    'code-file-image-preview',
    'code-file-pdf-preview',
    'code-file-metadata-preview-icon',
  ],
  componentSources: [
    'src/components/code/CodeMainArea.tsx',
    'src/components/files/FileChangesSection.tsx',
    'src/components/files/FileContextMenu.tsx',
    'src/components/files/FileEditorBlameDetail.tsx',
    'src/components/files/FileEditorBlameToast.tsx',
    'src/components/files/FileEditorInlineBlameLayer.tsx',
    'src/components/files/FileEditorLineChangesPanel.tsx',
    'src/components/files/FileOperationDialog.tsx',
    'src/components/files/FileSearchResults.tsx',
    'src/components/files/FileSectionBody.tsx',
    'src/components/files/FileSectionHeader.tsx',
    'src/components/files/FileTreeInlineOperation.tsx',
    'src/components/files/FileTreeRow.tsx',
    'src/components/files/FileTreeRowStatus.tsx',
    'src/components/files/FileTreeView.tsx',
    'src/components/files/OpenEditorsSection.tsx',
    'src/components/files/ProjectFilesSection.tsx',
  ],
  unstyledClassNames: [
    'code-file-blame-state',
    'code-file-change-directory-row',
    'code-file-change-tracked-group',
    'code-file-change-untracked-group',
    'code-file-changes-error',
    'code-file-changes-tracked-count',
    'code-file-changes-untracked-count',
    'code-file-open-error',
    'code-file-operation-backdrop',
    'code-file-operation-input',
    'code-file-operation-title',
  ],
  mustHaveBase: ['.code-file-row', '.code-file-tree', '.code-open-editor-row', '.code-files-header'],
})

console.log('test-files-style-ownership passed')
