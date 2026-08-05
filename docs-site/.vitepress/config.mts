import { defineConfig } from 'vitepress'

const base = process.env.FARMING_DOCS_BASE || '/farming/'
const siteOrigin = process.env.FARMING_DOCS_ORIGIN || 'https://zhuwenzhuang.github.io'

export default defineConfig({
  lang: 'zh-CN',
  title: 'Farming 文档',
  description: 'Farming Code 与 Farming CRT 的中文使用文档',
  base,
  cleanUrls: true,
  lastUpdated: true,
  sitemap: {
    hostname: `${siteOrigin}${base}`,
  },
  transformHead({ pageData }) {
    const relativePath = pageData.relativePath
      .replace(/index\.md$/, '')
      .replace(/\.md$/, '')
    const canonical = `${siteOrigin}${base}${relativePath}`
    return [
      ['link', { rel: 'canonical', href: canonical }],
      ['meta', { property: 'og:title', content: pageData.title || 'Farming 文档' }],
      ['meta', { property: 'og:description', content: pageData.description || 'Farming 中文使用文档' }],
      ['meta', { property: 'og:type', content: 'website' }],
      ['meta', { property: 'og:url', content: canonical }],
    ]
  },
  head: [
    ['meta', { name: 'theme-color', content: '#f7f4ec' }],
    ['link', { rel: 'icon', href: `${base}farming-icon.png` }],
  ],
  themeConfig: {
    logo: {
      light: '/farming-icon.png',
      dark: '/farming-crt-icon.svg',
    },
    siteTitle: 'Farming 文档',
    nav: [
      { text: 'Farming Code', link: '/cn/code/overview' },
      { text: 'Farming CRT', link: '/cn/crt/overview' },
      { text: '插件', link: '/cn/plugins/overview' },
      { text: '安装', link: '/cn/get-started/installation' },
      { text: '命令行', link: '/cn/cli/overview' },
      { text: 'GitHub', link: 'https://github.com/zhuwenzhuang/farming' },
    ],
    sidebar: [
      {
        text: '开始使用',
        items: [
          { text: '快速开始', link: '/cn/get-started/quickstart' },
          { text: '安装与更新', link: '/cn/get-started/installation' },
        ],
      },
      {
        text: 'Farming Code',
        items: [
          { text: '概览', link: '/cn/code/overview' },
          { text: '项目与 Agent', link: '/cn/code/projects-and-agents' },
          { text: 'Files', link: '/cn/code/files' },
          { text: 'Chat', link: '/cn/code/chat' },
          { text: 'Terminal', link: '/cn/code/terminal' },
          { text: 'Token 使用', link: '/cn/code/usage' },
          { text: '搜索与 History', link: '/cn/code/search-and-history' },
          { text: '手机与远程使用', link: '/cn/code/mobile-and-remote' },
        ],
      },
      {
        text: 'Farming CRT',
        items: [
          { text: '键盘控制室', link: '/cn/crt/overview' },
        ],
      },
      {
        text: '常见工作流',
        items: [
          { text: '理解一个代码库', link: '/cn/workflows/understand-a-codebase' },
          { text: '定位并修复问题', link: '/cn/workflows/fix-a-problem' },
          { text: '实现一个小功能', link: '/cn/workflows/build-a-small-feature' },
          { text: '检查、验证与收尾', link: '/cn/workflows/verify-and-finish' },
        ],
      },
      {
        text: '自定义',
        items: [
          { text: '设置', link: '/cn/customize/settings' },
          { text: 'Provider 与权限', link: '/cn/customize/providers-and-permissions' },
        ],
      },
      {
        text: '命令行界面',
        items: [
          { text: 'CLI 概览', link: '/cn/cli/overview' },
          { text: '服务管理', link: '/cn/cli/service-management' },
          { text: 'Agent 控制命令', link: '/cn/cli/agent-control' },
        ],
      },
      {
        text: '插件',
        items: [
          { text: '插件概览', link: '/cn/plugins/overview' },
          { text: 'Agent Homes', link: '/cn/plugins/agent-homes' },
          { text: 'Farming Browser', link: '/cn/browser/overview' },
          { text: 'Browser Agent 使用流程', link: '/cn/browser/agent-workflow' },
          {
            text: '实验性功能',
            collapsed: false,
            items: [
              { text: 'Farming Desktop', link: '/cn/experimental/desktop' },
              { text: 'Computer Use', link: '/cn/experimental/computer-use' },
              { text: 'Language Server', link: '/cn/experimental/language-server' },
            ],
          },
        ],
      },
      {
        text: '帮助',
        items: [
          { text: '故障排查', link: '/cn/help/troubleshooting' },
          { text: '常见问题', link: '/cn/help/faq' },
          { text: '术语表', link: '/cn/help/glossary' },
        ],
      },
    ],
    search: {
      provider: 'local',
      options: {
        translations: {
          button: {
            buttonText: '搜索文档',
            buttonAriaLabel: '搜索文档',
          },
          modal: {
            noResultsText: '没有找到相关内容',
            resetButtonTitle: '清除搜索',
            footer: {
              selectText: '选择',
              navigateText: '切换',
              closeText: '关闭',
            },
          },
        },
      },
    },
    outline: {
      label: '本页内容',
      level: [2, 3],
    },
    docFooter: {
      prev: '上一页',
      next: '下一页',
    },
    sidebarMenuLabel: '菜单',
    darkModeSwitchLabel: '外观',
    lightModeSwitchTitle: '切换到浅色主题',
    darkModeSwitchTitle: '切换到深色主题',
    returnToTopLabel: '返回顶部',
    lastUpdated: {
      text: '最后更新',
      formatOptions: {
        dateStyle: 'medium',
        timeStyle: 'short',
      },
    },
    editLink: {
      pattern: 'https://github.com/zhuwenzhuang/farming/edit/main/docs-site/:path',
      text: '在 GitHub 上编辑此页',
    },
    footer: {
      message: 'Farming 是一个开源、自托管的 AI Coding Agent 工作区。',
      copyright: '基于 MIT License 发布。',
    },
  },
})
