import { assertAppearanceNeutralStylePalette } from './style-ownership-contract'

assertAppearanceNeutralStylePalette({
  domain: 'markdown',
  mustHaveBase: ['.code-markdown-preview', '.code-markdown-mermaid', '.code-markdown-frontmatter'],
})

console.log('test-markdown-style-ownership passed')
