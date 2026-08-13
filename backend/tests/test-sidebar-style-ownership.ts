import { assertDomainStyleOwnership } from './style-ownership-contract'

assertDomainStyleOwnership({
  domain: 'sidebar',
  prefixes: ['code-sidebar', 'code-project', 'code-worktree', 'code-branch', 'code-pinned', 'code-session', 'code-nav', 'code-rename'],
  // Sidebar resource slots have their own extracted owner.
  excludePrefixes: ['code-sidebar-resource'],
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
    'code-project-worktree-menu',
    'code-session-show-less',
  ],
  mustHaveBase: ['.code-sidebar', '.code-project-title', '.code-nav-item', '.code-rename-dialog'],
})

console.log('test-sidebar-style-ownership passed')
