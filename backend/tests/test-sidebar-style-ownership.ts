import { assertDomainStyleOwnership } from './style-ownership-contract'

assertDomainStyleOwnership({
  domain: 'sidebar',
  prefixes: ['code-sidebar', 'code-project', 'code-worktree', 'code-pinned', 'code-session', 'code-nav', 'code-rename'],
  // Sidebar resource slots have their own extracted owner.
  excludePrefixes: ['code-sidebar-resource'],
  expected: {
    combined: [334, 'd310735bc2ec1351b06c26af7f70409608698abd49956b78e7093d66742c3e7f'],
    base: [247, '2f2a85f6ed2c4a0af99eea532bc335fc14173fd79fe73014979ec14ea4e9b098'],
    dark: [87, '3804501121002b9e235ae979e41e185773685c04a4b2826c3b4fb87a400fce43'],
  },
  componentSources: [
    'src/components/code/CodeSidebar.tsx',
    'src/components/CodeWorkspace.tsx',
    'src/components/code/CodeMainArea.tsx',
  ],
  // These hooks take their visual style from shared classes such as
  // .code-project-title-action and .code-nav-item.
  unstyledClassNames: [
    'code-nav-history',
    'code-nav-plugins',
    'code-nav-search',
    'code-pinned-agent-compact',
    'code-pinned-agent-strip',
    'code-project-actions',
    'code-project-agent-visibility',
    'code-project-new-agent',
    'code-project-new-agent-menu',
    'code-project-resource-slot',
    'code-project-worktree-menu',
    'code-session-show-less',
  ],
  mustHaveBase: ['.code-sidebar', '.code-project-title', '.code-nav-item', '.code-rename-dialog'],
  mustHaveDark: ['.code-sidebar', '.code-project-title'],
})

console.log('test-sidebar-style-ownership passed')
