import { assertAppearanceNeutralStylePalette } from './style-ownership-contract'

assertAppearanceNeutralStylePalette({
  domain: 'file-editor',
  mustHaveBase: ['.code-file-editor', '.code-file-monaco', '.code-file-preview-panel', '.code-file-diff'],
})

console.log('test-file-editor-style-ownership passed')
