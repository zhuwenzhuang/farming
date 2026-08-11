import { assertAppearanceNeutralStylePalette } from './style-ownership-contract'

assertAppearanceNeutralStylePalette({
  domain: 'usage',
  mustHaveBase: ['.code-usage-activity', '.code-usage-chart-summary', '.code-usage-detail-dialog'],
})

console.log('test-usage-style-ownership passed')
