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
  expected: {
    combined: [468, 'ebcd0dc4c1de73e7840ab28d5a3e988a2115dc10fa19a36ba0b9d9c49c7a573a'],
    base: [316, 'b3031d2ba9a2f07dd2f1e4a68f43a77e8002fc1262c784ee9ad8ca1ec8f682a8'],
    dark: [152, '699373a3446972e4ea08470242c0527b2326d9cc394281fb1e1a81191081661b'],
  },
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
    'src/components/files/FileStickyContext.tsx',
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
  mustHaveDark: ['.code-file-row', '.code-open-editor-main'],
})

console.log('test-files-style-ownership passed')
