import { defineConfig } from 'vitepress'

const configuredBase = process.env.FARMING_DOCS_BASE || '/farming/'
const base = configuredBase === '/'
  ? '/'
  : `/${configuredBase.replace(/^\/+|\/+$/g, '')}/`
const siteOrigin = (process.env.FARMING_DOCS_ORIGIN || 'https://zhuwenzhuang.github.io').replace(/\/+$/, '')
const absoluteDocsUrl = (path = '') => `${siteOrigin}${base}${path.replace(/^\/+/, '')}`
const routeFromRelativePath = (relativePath: string) => relativePath
  .replace(/index\.md$/, '')
  .replace(/\.md$/, '')
const themeFromUrlScript = `;(() => {
  const theme = new URLSearchParams(location.search).get('theme')
  if (theme !== 'dark' && theme !== 'light') return
  localStorage.setItem('vitepress-theme-appearance', theme)
  document.documentElement.classList.toggle('dark', theme === 'dark')
})()`

const zhNav = [
  { text: 'Farming Code', link: '/cn/code/overview' },
  { text: 'Farming CRT', link: '/cn/crt/overview' },
  { text: '插件', link: '/cn/plugins/overview' },
  { text: '安装', link: '/cn/get-started/installation' },
  { text: '命令行', link: '/cn/cli/overview' },
  { text: 'GitHub', link: 'https://github.com/zhuwenzhuang/farming' },
]

const enNav = [
  { text: 'Farming Code', link: '/en/code/overview' },
  { text: 'Farming CRT', link: '/en/crt/overview' },
  { text: 'Plugins', link: '/en/plugins/overview' },
  { text: 'Install', link: '/en/get-started/installation' },
  { text: 'CLI', link: '/en/cli/overview' },
  { text: 'GitHub', link: 'https://github.com/zhuwenzhuang/farming' },
]

const zhSidebar = [
  { text: '开始使用', items: [
    { text: '快速开始', link: '/cn/get-started/quickstart' },
    { text: '安装与更新', link: '/cn/get-started/installation' },
  ] },
  { text: 'Farming Code', items: [
    { text: '概览', link: '/cn/code/overview' },
    { text: '项目与 Agent', link: '/cn/code/projects-and-agents' },
    { text: 'Files', link: '/cn/code/files' },
    { text: 'Chat', link: '/cn/code/chat' },
    { text: 'Terminal', link: '/cn/code/terminal' },
    { text: 'Token 使用', link: '/cn/code/usage' },
    { text: '搜索与 History', link: '/cn/code/search-and-history' },
    { text: '分享与只读访问', link: '/cn/code/sharing' },
    { text: '手机与远程使用', link: '/cn/code/mobile-and-remote' },
  ] },
  { text: 'Farming CRT', items: [
    { text: '键盘控制室', link: '/cn/crt/overview' },
  ] },
  { text: '常见工作流', items: [
    { text: '理解一个代码库', link: '/cn/workflows/understand-a-codebase' },
    { text: '定位并修复问题', link: '/cn/workflows/fix-a-problem' },
    { text: '实现一个小功能', link: '/cn/workflows/build-a-small-feature' },
    { text: '检查、验证与收尾', link: '/cn/workflows/verify-and-finish' },
  ] },
  { text: '自定义', items: [
    { text: '设置', link: '/cn/customize/settings' },
    { text: 'Provider 与权限', link: '/cn/customize/providers-and-permissions' },
  ] },
  { text: '命令行界面', items: [
    { text: 'CLI 概览', link: '/cn/cli/overview' },
    { text: '服务管理', link: '/cn/cli/service-management' },
    { text: 'Agent 控制命令', link: '/cn/cli/agent-control' },
  ] },
  { text: '插件', items: [
    { text: '插件概览', link: '/cn/plugins/overview' },
    { text: 'Agent Homes', link: '/cn/plugins/agent-homes' },
    { text: 'Farming Browser', link: '/cn/browser/overview' },
    { text: 'Browser Agent 使用流程', link: '/cn/browser/agent-workflow' },
    { text: '实验性功能', collapsed: false, items: [
      { text: 'Farming Desktop', link: '/cn/experimental/desktop' },
      { text: 'Computer Use', link: '/cn/experimental/computer-use' },
      { text: 'Language Server', link: '/cn/experimental/language-server' },
    ] },
  ] },
  { text: '帮助', items: [
    { text: '故障排查', link: '/cn/help/troubleshooting' },
    { text: '常见问题', link: '/cn/help/faq' },
    { text: '术语表', link: '/cn/help/glossary' },
  ] },
]

const enSidebar = [
  { text: 'Get started', items: [
    { text: 'Quick start', link: '/en/get-started/quickstart' },
    { text: 'Installation and updates', link: '/en/get-started/installation' },
  ] },
  { text: 'Farming Code', items: [
    { text: 'Overview', link: '/en/code/overview' },
    { text: 'Projects and Agents', link: '/en/code/projects-and-agents' },
    { text: 'Files', link: '/en/code/files' },
    { text: 'Chat', link: '/en/code/chat' },
    { text: 'Terminal', link: '/en/code/terminal' },
    { text: 'Token usage', link: '/en/code/usage' },
    { text: 'Search and History', link: '/en/code/search-and-history' },
    { text: 'Sharing and read-only access', link: '/en/code/sharing' },
    { text: 'Mobile and remote use', link: '/en/code/mobile-and-remote' },
  ] },
  { text: 'Farming CRT', items: [
    { text: 'Keyboard control room', link: '/en/crt/overview' },
  ] },
  { text: 'Common workflows', items: [
    { text: 'Understand a codebase', link: '/en/workflows/understand-a-codebase' },
    { text: 'Find and fix a problem', link: '/en/workflows/fix-a-problem' },
    { text: 'Build a small feature', link: '/en/workflows/build-a-small-feature' },
    { text: 'Verify and finish', link: '/en/workflows/verify-and-finish' },
  ] },
  { text: 'Customize', items: [
    { text: 'Settings', link: '/en/customize/settings' },
    { text: 'Providers and permissions', link: '/en/customize/providers-and-permissions' },
  ] },
  { text: 'Command line', items: [
    { text: 'CLI overview', link: '/en/cli/overview' },
    { text: 'Service management', link: '/en/cli/service-management' },
    { text: 'Agent control commands', link: '/en/cli/agent-control' },
  ] },
  { text: 'Plugins', items: [
    { text: 'Plugin overview', link: '/en/plugins/overview' },
    { text: 'Agent Homes', link: '/en/plugins/agent-homes' },
    { text: 'Farming Browser', link: '/en/browser/overview' },
    { text: 'Agent Browser workflow', link: '/en/browser/agent-workflow' },
    { text: 'Experimental features', collapsed: false, items: [
      { text: 'Farming Desktop', link: '/en/experimental/desktop' },
      { text: 'Computer Use', link: '/en/experimental/computer-use' },
      { text: 'Language Server', link: '/en/experimental/language-server' },
    ] },
  ] },
  { text: 'Help', items: [
    { text: 'Troubleshooting', link: '/en/help/troubleshooting' },
    { text: 'FAQ', link: '/en/help/faq' },
    { text: 'Glossary', link: '/en/help/glossary' },
  ] },
]

const commonTheme = {
  logo: {
    light: '/farming-icon.png',
    dark: '/farming-crt-icon.svg',
  },
}

const zhTheme = {
  ...commonTheme,
  siteTitle: 'Farming 文档',
  nav: zhNav,
  sidebar: zhSidebar,
  search: {
    provider: 'local' as const,
    options: {
      translations: {
        button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
        modal: {
          noResultsText: '没有找到相关内容',
          resetButtonTitle: '清除搜索',
          footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' },
        },
      },
    },
  },
  outline: { label: '本页内容', level: [2, 3] as [number, number] },
  docFooter: { prev: '上一页', next: '下一页' },
  sidebarMenuLabel: '菜单',
  darkModeSwitchLabel: '外观',
  lightModeSwitchTitle: '切换到浅色主题',
  darkModeSwitchTitle: '切换到深色主题',
  returnToTopLabel: '返回顶部',
  lastUpdated: {
    text: '最后更新',
    formatOptions: { dateStyle: 'medium' as const, timeStyle: 'short' as const },
  },
  editLink: {
    pattern: 'https://github.com/zhuwenzhuang/farming/edit/main/docs-site/:path',
    text: '在 GitHub 上编辑此页',
  },
  footer: {
    message: 'Farming 是一个开源、自托管的 AI Coding Agent 工作区。',
    copyright: '基于 MIT License 发布。',
  },
}

const enTheme = {
  ...commonTheme,
  siteTitle: 'Farming Documentation',
  nav: enNav,
  sidebar: enSidebar,
  search: { provider: 'local' as const },
  outline: { label: 'On this page', level: [2, 3] as [number, number] },
  docFooter: { prev: 'Previous page', next: 'Next page' },
  sidebarMenuLabel: 'Menu',
  darkModeSwitchLabel: 'Appearance',
  lightModeSwitchTitle: 'Switch to light theme',
  darkModeSwitchTitle: 'Switch to dark theme',
  returnToTopLabel: 'Return to top',
  lastUpdated: {
    text: 'Last updated',
    formatOptions: { dateStyle: 'medium' as const, timeStyle: 'short' as const },
  },
  editLink: {
    pattern: 'https://github.com/zhuwenzhuang/farming/edit/main/docs-site/:path',
    text: 'Edit this page on GitHub',
  },
  footer: {
    message: 'Farming is an open-source, self-hosted workspace for AI coding agents.',
    copyright: 'Released under the MIT License.',
  },
}

export default defineConfig({
  lang: 'zh-CN',
  title: 'Farming 文档',
  description: 'Farming Code 与 Farming CRT 的使用文档',
  base,
  cleanUrls: true,
  lastUpdated: true,
  locales: {
    cn: {
      label: '简体中文',
      lang: 'zh-CN',
      link: '/cn/',
      title: 'Farming 文档',
      description: 'Farming Code 与 Farming CRT 的中文使用文档',
      themeConfig: zhTheme,
    },
    en: {
      label: 'English',
      lang: 'en-US',
      link: '/en/',
      title: 'Farming Documentation',
      description: 'User documentation for Farming Code and Farming CRT',
      themeConfig: enTheme,
    },
  },
  sitemap: { hostname: absoluteDocsUrl() },
  transformHead({ pageData }) {
    if (pageData.relativePath === '404.md' || pageData.relativePath.startsWith('public/')) {
      return [['meta', { name: 'robots', content: 'noindex, nofollow' }]]
    }

    const relativePath = routeFromRelativePath(pageData.relativePath)
    const canonical = absoluteDocsUrl(relativePath)
    const english = pageData.relativePath.startsWith('en/')
    const localizedPath = pageData.relativePath.replace(/^(cn|en)\//, '')
    const chineseUrl = absoluteDocsUrl(routeFromRelativePath(`cn/${localizedPath}`))
    const englishUrl = absoluteDocsUrl(routeFromRelativePath(`en/${localizedPath}`))
    const defaultTitle = english ? 'Farming Documentation' : 'Farming 文档'
    const defaultDescription = english
      ? 'User documentation for Farming Code and Farming CRT'
      : 'Farming Code 与 Farming CRT 的中文使用文档'
    const title = pageData.title || defaultTitle
    const description = pageData.description || defaultDescription
    const image = absoluteDocsUrl('farming-hero.png')
    return [
      ['link', { rel: 'canonical', href: canonical }],
      ['link', { rel: 'alternate', hreflang: 'zh-CN', href: chineseUrl }],
      ['link', { rel: 'alternate', hreflang: 'en-US', href: englishUrl }],
      ['link', { rel: 'alternate', hreflang: 'x-default', href: absoluteDocsUrl() }],
      ['meta', { property: 'og:title', content: title }],
      ['meta', { property: 'og:description', content: description }],
      ['meta', { property: 'og:type', content: pageData.relativePath === 'index.md' ? 'website' : 'article' }],
      ['meta', { property: 'og:url', content: canonical }],
      ['meta', { property: 'og:site_name', content: 'Farming Documentation' }],
      ['meta', { property: 'og:locale', content: english ? 'en_US' : 'zh_CN' }],
      ['meta', { property: 'og:locale:alternate', content: english ? 'zh_CN' : 'en_US' }],
      ['meta', { property: 'og:image', content: image }],
      ['meta', { property: 'og:image:width', content: '1254' }],
      ['meta', { property: 'og:image:height', content: '1254' }],
      ['meta', { property: 'og:image:alt', content: english ? 'Farming documentation' : 'Farming 文档' }],
      ['meta', { name: 'twitter:card', content: 'summary' }],
      ['meta', { name: 'twitter:title', content: title }],
      ['meta', { name: 'twitter:description', content: description }],
      ['meta', { name: 'twitter:image', content: image }],
    ]
  },
  head: [
    ['script', {}, themeFromUrlScript],
    ['meta', { name: 'theme-color', content: '#f7f4ec' }],
    ['link', { rel: 'icon', href: `${base}farming-icon.png` }],
  ],
  themeConfig: {
    ...zhTheme,
    i18nRouting: true,
  },
})
