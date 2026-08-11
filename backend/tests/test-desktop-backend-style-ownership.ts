import { assertDomainStyleOwnership } from './style-ownership-contract'

assertDomainStyleOwnership({
  domain: 'desktop-backend',
  prefixes: ['desktop-backend'],
  componentSources: ['src/components/DesktopConnectionsPanel.tsx'],
  mustHaveBase: ['.desktop-backend-bar', '.desktop-backend-dialog'],
})

console.log('test-desktop-backend-style-ownership passed')
