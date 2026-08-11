import { assertAppearanceNeutralStylePalette } from './style-ownership-contract'

assertAppearanceNeutralStylePalette({
  domain: 'settings',
  mustHaveBase: ['.code-settings-panel', '.code-settings-update-card', '.code-agent-home-provider'],
})

console.log('test-settings-style-ownership passed')
