import { assertDomainStyleOwnership } from './style-ownership-contract'

assertDomainStyleOwnership({
  domain: 'language-server',
  prefixes: ['code-language-server'],
  // Splitter paint is shared with navigation and side-session layout chrome.
  mainIntegrationSelectors: [
    ':is(.code-sidebar-resizer, .code-resource-agent-resizer, .code-related-session-resizer, .code-language-server-resizer)',
    ':is(.code-sidebar-resizer, .code-resource-agent-resizer, .code-related-session-resizer, .code-language-server-resizer):is(:hover, :active, :focus-visible)',
    ':is(.code-sidebar-resizer, .code-resource-agent-resizer, .code-related-session-resizer, .code-language-server-resizer):focus-visible',
    'body.code-resizing-language-server-dock .code-language-server-resizer',
  ],
  componentSources: [
    'src/components/files/FileEditorPane.tsx',
    'src/components/files/LanguageServerPanel.tsx',
  ],
  unstyledClassNames: ['code-language-server-dock-width'],
  mustHaveBase: ['.code-language-server-panel', '.code-language-server-node'],
})

console.log('test-language-server-style-ownership passed')
