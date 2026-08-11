import { assertAppearanceNeutralStylePalette } from './style-ownership-contract'

assertAppearanceNeutralStylePalette({
  domain: 'plugin',
  mustHaveBase: ['.code-plugin-view', '.code-plugin-card', '.code-plugin-manifest-icon'],
})

console.log('test-plugin-style-ownership passed')
