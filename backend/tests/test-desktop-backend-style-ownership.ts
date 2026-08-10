import { assertDomainStyleOwnership } from './style-ownership-contract'

assertDomainStyleOwnership({
  domain: 'desktop-backend',
  prefixes: ['desktop-backend'],
  expected: {
    combined: [65, '29dddf6c99bf193817ce44d42cecbccaf783e93e898e3085649687459c0d56bd'],
    base: [51, 'cfa5b854c853f6519a0471f5589c2c9aae4411f82340356cae7d75addbe6b6d3'],
    dark: [14, '3c36406aa941e9fce01bef9b77cb8022d287626baf3ed00fc0f203fb19194c4a'],
  },
  componentSources: ['src/components/DesktopConnectionsPanel.tsx'],
  mustHaveBase: ['.desktop-backend-bar', '.desktop-backend-dialog'],
  mustHaveDark: ['.desktop-backend-dialog'],
})

console.log('test-desktop-backend-style-ownership passed')
