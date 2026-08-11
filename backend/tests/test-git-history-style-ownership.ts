import { assertAppearanceNeutralStylePalette } from './style-ownership-contract'

assertAppearanceNeutralStylePalette({
  domain: 'git-history',
  mustHaveBase: ['.code-git-history-section', '.code-git-history-entry', '.code-git-history-graph'],
})

console.log('test-git-history-style-ownership passed')
