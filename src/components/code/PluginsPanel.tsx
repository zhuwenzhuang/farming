import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, KeyboardEvent as ReactKeyboardEvent, SetStateAction } from 'react'
import { CodeSelect } from '@/components/CodeSelect'
import { appPath } from '@/lib/base-path'
import { agentDisplayName as formatAgentDisplayName } from '@/lib/format'
import type { WorkspacePluginsNavigationState } from '@/lib/workspace-navigation-history'
import { getBackendConnectionSnapshot } from '@/lib/backend-live-status'
import { RequestOwnershipFence } from '@/lib/request-ownership'
import {
  ArrowLeftGlyph,
  BrowserGlyph,
  CloseGlyph,
  ComputerUseGlyph,
  HookGlyph,
  LanguageServerGlyph,
  McpGlyph,
  PencilGlyph,
  PlusGlyph,
  PuzzleGlyph,
  SkillGlyph,
  TerminalSquareGlyph,
} from '@/components/IconGlyphs'
import { DesktopConnectionsPanel } from '@/components/DesktopConnectionsPanel'
import type { UiLanguage } from '@/lib/ui-preferences'
import type { BrowserCapability } from '../../../extensions/browser/frontend/types'
import type { ComputerCapability } from '../../../extensions/computer/frontend/types'
import { fetchLanguageServerCapability } from '../../../extensions/language-server/frontend/client'
import type {
  LanguageServerCapability,
  LanguageServerRuntimeCapability,
  LanguageServerRuntimeStatus,
} from '../../../extensions/language-server/frontend/types'

type NewAgentDefaults = {
  model: string
  reasoning: string
  fast: 'inherit' | 'on' | 'off'
}

type BrowserExtensionCapability = NonNullable<BrowserCapability['extension']>

type AgentExtension = {
  id: string
  name: string
  description: string
  kind: string
  scope: string
  status: 'configured' | 'enabled' | 'disabled'
  sourceFile: string
  rootId: string
  icon?: string
  iconDark?: string
  iconPath?: string
  iconDarkPath?: string
}

type AgentExtensionGroup = {
  id: string
  name: string
  description: string
  available: boolean
  discoverySupported: boolean
  acpExecutablePolicy: 'managed' | 'system'
  launchDefaults: {
    homeId: string
    runtimeMode: 'terminal' | 'chat'
  }
  supportsChat: boolean
  homes: Array<{
    id: string
    path: string
    order: number
    acpRuntime: {
      mode: 'managed' | 'custom'
      executable: string
    }
    newAgentDefaults: NewAgentDefaults
    configuration: {
      exists: boolean
      filePath: string
      rootId: string
      summary: Array<{
        key: 'approval' | 'model' | 'permission' | 'provider' | 'reasoning' | 'sandbox' | 'serviceTier'
        value: string
      }>
    }
    extensions: AgentExtension[]
  }>
}

type AgentHomeDraft = {
  provider: string
  id: string
  path: string
}

type AgentConfiguration = {
  provider: AgentExtensionGroup
  home: AgentExtensionGroup['homes'][number]
}

export type AgentHomeFileTarget = {
  exists: boolean
  filePath: string
  homePath: string
  rootId: string
}

export type PluginsTab = 'farming' | 'homes' | 'extensions'

export type PluginsNavigationState = WorkspacePluginsNavigationState

export function defaultPluginsNavigationState(): PluginsNavigationState {
  return {
    activeTab: 'farming',
    activeExtensionHomeKey: '',
    activeExtensionKind: 'plugin',
    extensionQuery: '',
    selectedExtension: null,
    scrollTop: 0,
  }
}

const EXTENSION_KIND_ORDER = ['plugin', 'skill', 'mcp', 'hook', 'command']
const PLUGIN_TAB_DEFINITIONS = [
  { id: 'farming' },
  { id: 'homes' },
  { id: 'extensions' },
] as const satisfies ReadonlyArray<{ id: PluginsTab }>
const PLUGINS_TABS = PLUGIN_TAB_DEFINITIONS.map(tab => tab.id)
const AGENT_SETTINGS_REQUEST_TIMEOUT_MS = 15_000
const PLUGIN_SCROLL_SAVE_SETTLE_MS = 120
const DOCKER_DESKTOP_MAC_INSTALL_URL = 'https://docs.docker.com/desktop/setup/install/mac-install/'
const DOCKER_ENGINE_INSTALL_URL = 'https://docs.docker.com/engine/install/'
const FARMING_BROWSER_DOCS_URL: Record<UiLanguage, string> = {
  en: 'https://zhuwenzhuang.github.io/farming/en/browser/existing-chrome',
  zh: 'https://zhuwenzhuang.github.io/farming/cn/browser/existing-chrome',
}
const CHROME_EXTENSIONS_ADDRESS = 'chrome://extensions'

function formatByteSize(value: number | undefined) {
  if (!Number.isFinite(value) || value === undefined || value < 0) return '—'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`
}

async function fetchAgentSettings(url: string, init?: RequestInit) {
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), AGENT_SETTINGS_REQUEST_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    window.clearTimeout(timeoutId)
  }
}

function pluginCopy(language: UiLanguage) {
  const zh = language === 'zh'
  return {
    title: zh ? '插件' : 'Plugins',
    description: zh ? '管理 Farming 和 Agent 可以使用的能力。' : 'Manage capabilities available to Farming and Agents.',
    goBack: zh ? '返回' : 'Back',
    tabs: {
      farming: 'Farming',
      homes: 'Agent Homes',
      extensions: zh ? '扩展' : 'Extensions',
    },
    farmingBuiltIn: zh ? 'Farming 内置' : 'Built into Farming',
    farmingBuiltInDescription: zh ? '由 Farming 提供并统一管理的能力。' : 'Capabilities provided and managed by Farming.',
    agentHomes: 'Agent Homes',
    agentHomesDescription: zh
      ? '配置 Agent Home，以及新 Agent 的默认 Home 和 Runtime。'
      : 'Configure Agent Homes and the default Home and runtime for new Agents.',
    agentExtensions: zh ? 'Agent 扩展' : 'Agent extensions',
    agentExtensionsDescription: zh
      ? '按 Home 查看发现的 Skill、MCP、Hook、插件和命令。'
      : 'Skills, MCPs, hooks, plugins, and commands discovered in each Agent Home.',
    searchExtensions: zh ? '搜索扩展' : 'Search extensions',
    refresh: zh ? '刷新' : 'Refresh',
    noMatchingExtensions: zh ? '没有匹配的扩展。' : 'No matching extensions.',
    addAgent: zh ? '添加 Agent' : 'Add Agent',
    edit: zh ? '编辑配置' : 'Edit configuration',
    remove: zh ? '删除' : 'Remove',
    launchDefault: zh ? '启动默认' : 'Launch default',
    setLaunchDefault: zh ? '设为默认' : 'Set as default',
    defaultRuntime: zh ? '默认 Runtime' : 'Default runtime',
    save: zh ? '保存' : 'Save',
    cancel: zh ? '取消' : 'Cancel',
    dragToReorder: zh ? '拖动调整 Agent 顺序' : 'Drag to reorder Agents',
    unavailableAgent: zh ? '未安装' : 'Not installed',
    model: zh ? '模型' : 'Model',
    provider: zh ? '提供方' : 'Provider',
    reasoning: zh ? '推理强度' : 'Reasoning',
    serviceTier: zh ? '服务等级' : 'Service tier',
    approval: zh ? '审批' : 'Approval',
    sandbox: zh ? '沙箱' : 'Sandbox',
    permission: zh ? '权限' : 'Permission',
    homeConfiguration: zh ? 'Home 配置' : 'Home configuration',
    inheritConfiguration: (filePath: string) => zh
      ? `继承 ${filePath}`
      : `Inherited from ${filePath}`,
    missingConfiguration: (filePath: string) => zh
      ? `未找到 ${filePath}；编辑后首次保存会创建它。`
      : `${filePath} was not found; the first save after editing will create it.`,
    agentProvider: zh ? 'Agent 类型' : 'Agent provider',
    homeName: zh ? 'Home 名称' : 'Home name',
    homePath: zh ? 'Home 路径' : 'Home path',
    homeNamePlaceholder: zh ? '例如 work' : 'e.g. work',
    homePathPlaceholder: '~/.codex-work',
    invalidHome: zh ? '请输入有效且不重复的 Home 名称和路径。' : 'Enter a valid, unique Home name and path.',
    saveAgentFailed: zh ? 'Agent 设置保存失败' : 'Failed to save Agent settings',
    confirmRemoveAgent: (name: string) => zh ? `删除 ${name}？` : `Remove ${name}?`,
    confirmRemoveDefaultAgent: (name: string) => zh
      ? `删除 ${name}？新 Agent 的启动默认将自动切回 default Home。`
      : `Remove ${name}? New Agents will automatically fall back to the default Home.`,
    loadingAgentExtensions: zh ? '正在读取 Agent 扩展…' : 'Loading Agent extensions…',
    agentExtensionsFailed: zh ? 'Agent 扩展读取失败' : 'Failed to load Agent extensions',
    agentExtensionsDisconnected: zh
      ? 'Farming 后端暂不可用；重新连接后会自动重试。'
      : 'Farming backend is unavailable; this will retry after reconnecting.',
    noAgentExtensions: zh ? '没有发现扩展。' : 'No extensions found.',
    unsupportedDiscovery: zh ? '这个 Agent 还没有统一的扩展发现接口。' : 'This Agent does not expose a unified extension discovery interface yet.',
    home: zh ? 'Home' : 'Home',
    count: (count: number) => zh ? `${count} 项` : `${count} items`,
    kind: {
      skill: zh ? 'Skill' : 'Skill',
      mcp: 'MCP',
      hook: 'Hook',
      plugin: zh ? '插件' : 'Plugin',
      command: zh ? '命令' : 'Command',
    },
    kindTabs: {
      skill: 'Skills',
      mcp: 'MCPs',
      hook: 'Hooks',
      plugin: zh ? '插件' : 'Plugins',
      command: zh ? '命令' : 'Commands',
    },
    extensionDetails: zh ? '扩展详情' : 'Extension details',
    closeDetails: zh ? '关闭详情' : 'Close details',
    source: zh ? '来源' : 'Source',
    openSource: zh ? '打开来源文件' : 'Open source file',
    extensionStatus: {
      configured: zh ? '已配置' : 'Configured',
      enabled: zh ? '已启用' : 'Enabled',
      disabled: zh ? '已停用' : 'Disabled',
    },
    browser: zh ? '浏览器' : 'Browser',
    browserDescription: zh
      ? '让 Agent 打开和操作网页。'
      : 'Let Agents open and operate webpages.',
    enabled: zh ? '已启用' : 'Enabled',
    disabled: zh ? '已停用' : 'Disabled',
    unavailable: zh ? '未就绪' : 'Not ready',
    checking: zh ? '正在检查…' : 'Checking…',
    checkFailed: zh ? '检查失败' : 'Check failed',
    browserCheckFailed: zh ? '浏览器当前状态检查失败。' : 'Failed to check the current Browser status.',
    computerCheckFailed: zh ? 'Computer Use 当前状态检查失败。' : 'Failed to check the current Computer Use status.',
    newBrowser: zh ? '新浏览器' : 'New browser',
    newBrowserDescription: zh
      ? '新开网页，不使用你 Chrome 里的页面和登录状态。'
      : 'Opens webpages separately without using pages or signed-in state from your Chrome.',
    noSystemBrowser: zh ? '这台电脑未找到 Chrome 或 Chromium' : 'Chrome or Chromium was not found on this computer',
    extensionBrowser: zh ? '我的 Chrome' : 'My Chrome',
    extensionBrowserDescription: zh
      ? '直接使用你已经打开的页面和登录状态。'
      : 'Uses pages already open in your Chrome, including their signed-in state.',
    extensionConnected: zh ? 'Farming Browser Connector 已连接。' : 'Farming Browser Connector is connected.',
    extensionWaiting: zh ? '等待 Farming Browser Connector 连接。' : 'Waiting for Farming Browser Connector.',
    extensionStatusFailed: zh ? 'Farming Browser Connector 状态加载失败' : 'Failed to load Farming Browser Connector status',
    isolatedBrowser: zh ? 'Docker 中的浏览器（实验性）' : 'Browser in Docker (Experimental)',
    isolatedBrowserDescription: zh
      ? '在隔离环境中打开网页，适合需要隔离的任务。'
      : 'Opens webpages in an isolated environment for tasks that need separation.',
    browserChoice: zh ? '浏览器方式' : 'Browser options',
    ready: zh ? '可用' : 'Available',
    notReady: zh ? '当前不可用' : 'Currently unavailable',
    prepareConnectorDirectory: zh ? '准备 Chrome 扩展目录' : 'Prepare Chrome extension folder',
    removeConnectorDirectory: zh ? '删除 Chrome 扩展目录' : 'Remove Chrome extension folder',
    confirmRemoveConnectorDirectory: zh
      ? '删除后，Chrome 中已加载的 Farming Browser Connector 将无法继续使用。请先在 Chrome 扩展程序页删除扩展。仍要删除目录吗？'
      : 'Removing this folder makes the loaded Farming Browser Connector unavailable in Chrome. Remove the extension from Chrome first. Remove the folder anyway?',
    connectorGuide: zh ? '安装步骤说明' : 'Installation steps',
    connectorDirectory: zh ? 'Chrome 扩展目录' : 'Chrome extension folder',
    connectorExtensionsPage: zh ? 'Chrome 扩展程序页' : 'Chrome Extensions page',
    connectorCopyAddress: zh ? '复制地址' : 'Copy address',
    connectorAddressCopied: zh ? '已复制' : 'Copied',
    connectorCopyFailed: zh ? '地址复制失败，请手动复制。' : 'Failed to copy the address. Copy it manually.',
    connectorSize: zh ? '大小' : 'Size',
    connectorIntegrity: zh ? '完整性' : 'Integrity',
    connectorIntegrityValue: {
      valid: zh ? '完整' : 'Complete',
      missing: zh ? '未准备' : 'Not prepared',
      invalid: zh ? '异常' : 'Invalid',
    },
    connectorReadyHint: zh
      ? '复制下面地址并粘贴到 Chrome 地址栏。开启“开发者模式”，点击“加载已解压的扩展程序”，选择下面目录。'
      : 'Copy the address below into Chrome\'s address bar. Enable Developer mode, click Load unpacked, and choose the folder below.',
    preparingConnector: zh ? '正在准备目录…' : 'Preparing folder…',
    removingConnector: zh ? '正在删除目录…' : 'Removing folder…',
    connectorPrepareFailed: zh ? '连接扩展准备失败' : 'Failed to prepare the connector extension',
    connectorRemoveFailed: zh ? '插件目录删除失败' : 'Failed to remove the connector folder',
    installDocker: zh ? '安装 Docker' : 'Install Docker',
    notInstalled: zh ? '未安装' : 'Not installed',
    dockerRequired: zh ? '需要 Docker' : 'Docker required',
    prepareIsolatedBrowser: zh ? '安装（约 2 GB）' : 'Install (about 2 GB)',
    preparingIsolatedBrowser: zh ? '正在下载并验证…' : 'Downloading and verifying…',
    isolatedBrowserPrepareFailed: zh ? 'Docker 中的浏览器安装失败' : 'Failed to install Browser in Docker',
    dockerMacGuidance: zh
      ? '普通网页操作直接使用本机浏览器即可。需要 Docker 中的浏览器、Docker 中的桌面或 CUA 时，建议安装并启动 Docker Desktop；完成后重新打开插件页。'
      : 'Use a local browser for ordinary webpage work. Install and start Docker Desktop only when you need a Browser or Desktop in Docker, or CUA; then reopen Plugins.',
    dockerHostGuidance: zh
      ? '普通网页操作直接使用本机浏览器即可。需要 Docker 中的浏览器、Docker 中的桌面或 CUA 时，请安装并启动 Docker；完成后重新打开插件页。'
      : 'Use a local browser for ordinary webpage work. Install and start Docker only when you need a Browser or Desktop in Docker, or CUA; then reopen Plugins.',
    installDockerDesktop: zh ? '安装 Docker Desktop' : 'Install Docker Desktop',
    viewDockerInstallGuide: zh ? '查看 Docker 安装说明' : 'View Docker installation guide',
    isolatedCompatibilityRequired: zh
      ? '这台旧版 Docker 需要显式启用兼容模式后再重试。'
      : 'This older Docker Engine requires compatibility mode before retrying.',
    browserChangeHint: '',
    enable: zh ? '启用' : 'Enable',
    disable: zh ? '停用' : 'Disable',
    saveFailed: zh ? '浏览器插件设置保存失败' : 'Failed to save Browser plugin settings',
    computer: zh ? 'Computer Use（实验性）' : 'Computer Use (Experimental)',
    computerDescription: zh
      ? '让 Agent 查看并操作桌面，你可以在 Farming 中观察或接管。'
      : 'Let Agents see and operate desktops that you can observe or take over in Farming.',
    dockerUnavailable: zh ? '未检测到 Docker' : 'Docker not available',
    computerRuntimeReady: zh ? 'Docker 中的桌面已安装' : 'Desktop in Docker installed',
    computerRuntimeMissing: zh ? 'Docker 中的桌面未安装' : 'Desktop in Docker not installed',
    desktopTargets: zh ? '桌面' : 'Desktops',
    isolatedDesktop: zh ? 'Docker 中的桌面（实验性）' : 'Desktop in Docker (Experimental)',
    isolatedDesktopDescription: zh
      ? '独立的 Linux 桌面，适合并行任务。需要 Docker。'
      : 'An independent Linux desktop for parallel work. Requires Docker.',
    prepareComputer: zh ? '安装 Docker 中的桌面' : 'Install Desktop in Docker',
    preparingComputer: zh ? '正在下载并验证…' : 'Downloading and verifying…',
    computerRuntimeHint: zh
      ? '显式下载固定版本的官方 CUA XFCE 镜像（下载约 472 MB，本地约 1.3 GB）。'
      : 'Explicitly downloads the pinned official CUA XFCE image (about 472 MB download and 1.3 GB on disk).',
    compatibilityMode: zh ? '旧版 Docker 兼容模式' : 'Legacy Docker compatibility mode',
    compatibilityHint: zh
      ? '仅在旧 Docker 的 seccomp 阻止 CUA 启动时启用；该模式会对隔离容器关闭 seccomp。'
      : 'Enable only when old Docker seccomp blocks CUA startup; this disables seccomp for the isolated container.',
    computerSaveFailed: zh ? 'Computer Use 插件设置保存失败' : 'Failed to save Computer Use plugin settings',
    computerPrepareFailed: zh ? 'Docker 中的桌面安装失败' : 'Failed to install Desktop in Docker',
    languageServer: 'Language Server',
    languageServerUnavailable: zh ? '不可用' : 'Unavailable',
    languageServerRestartRequired: zh ? '需重启 Farming 以加载语言状态' : 'Restart Farming to load language status',
    languageServerError: zh ? '错误' : 'Error',
    languageServerSaveFailed: zh ? 'Language Server 设置保存失败' : 'Failed to save Language Server settings',
    languageServerSaving: zh ? '正在保存…' : 'Saving…',
    languageServerChecking: zh ? '正在发现…' : 'Discovering…',
    languageServerSummary: (counts: Record<LanguageServerRuntimeStatus, number>) => zh
      ? `${counts.running} 正在运行 · ${counts.available} 可用 · ${counts.installable} 可自动安装 · ${counts.missing} 未安装`
      : `${counts.running} running · ${counts.available} available · ${counts.installable} auto-installable · ${counts.missing} not installed`,
    languageServerLanguage: zh ? '语言' : 'Language',
    languageServerStatus: zh ? '状态' : 'Status',
    languageServerProject: zh ? '项目' : 'Project',
    languageServerRuntimeStatus: {
      running: zh ? '正在运行' : 'Running',
      available: zh ? '可用' : 'Available',
      installable: zh ? '可自动安装' : 'Auto-installable',
      missing: zh ? '未安装' : 'Not installed',
    } satisfies Record<LanguageServerRuntimeStatus, string>,
    languageServerMore: (count: number) => zh ? `更多 ${count} 种语言` : `${count} more languages`,
    languageServerTotal: (count: number) => zh ? `共 ${count} 种语言` : `${count} languages`,
    languageServerShowAll: zh ? '查看全部' : 'Show all',
    languageServerCollapse: zh ? '收起' : 'Collapse',
    remoteConnections: zh ? '远程连接' : 'Remote connections',
    remoteConnectionsDescription: zh
      ? '管理桌面应用的本机环境和 SSH 远端；仅在需要时切换。'
      : 'Manage the desktop app local environment and SSH remotes; switch only when needed.',
    manage: zh ? '管理' : 'Manage',
    builtIn: zh ? '内置' : 'Built-in',
  }
}

function languageServerPath(value: string) {
  try {
    const url = new URL(value)
    let pathname = decodeURIComponent(url.pathname)
    if (/^\/[A-Za-z]:/.test(pathname)) pathname = pathname.slice(1)
    return pathname.replace(/\/$/, '') || pathname
  } catch {
    return value
  }
}

const LANGUAGE_SERVER_RUNTIME_STATUS_ORDER: Record<LanguageServerRuntimeStatus, number> = {
  running: 0,
  available: 1,
  installable: 2,
  missing: 3,
}

function languageServerLanguages(capability: LanguageServerCapability | null): LanguageServerRuntimeCapability[] {
  if (!capability) return []
  const languages = capability.languages?.length
    ? capability.languages
    : [...new Set(capability.connections.map(connection => connection.id))].map(id => ({
        id,
        language: id,
        server: id,
        status: 'running' as const,
        projects: capability.connections
          .filter(connection => connection.id === id)
          .map(connection => connection.workspace),
      }))
  return [...languages].sort((left, right) => (
    LANGUAGE_SERVER_RUNTIME_STATUS_ORDER[left.status] - LANGUAGE_SERVER_RUNTIME_STATUS_ORDER[right.status]
    || left.language.localeCompare(right.language, 'en')
  ))
}

function languageServerProjectName(value: string) {
  const projectPath = languageServerPath(value)
  const segments = projectPath.split(/[\\/]/).filter(Boolean)
  return segments[segments.length - 1] || projectPath
}

function agentDisplayName(agent: Pick<AgentExtensionGroup, 'id' | 'name'>) {
  return formatAgentDisplayName(agent.id, agent.name || agent.id)
}

const EXTENSION_KIND_GLYPHS = {
  plugin: PuzzleGlyph,
  skill: SkillGlyph,
  mcp: McpGlyph,
  hook: HookGlyph,
  command: TerminalSquareGlyph,
} as const

const FARMING_BUILTIN_EXTENSIONS = [
  { id: 'desktop-connections', desktopOnly: true },
  { id: 'browser' },
  { id: 'computer' },
  { id: 'language-server' },
] as const

function farmingBuiltinExtensionCount(desktopAvailable: boolean) {
  return FARMING_BUILTIN_EXTENSIONS.filter(extension => (
    !('desktopOnly' in extension) || desktopAvailable
  )).length
}

function knownExtensionKind(kind: string): kind is keyof typeof EXTENSION_KIND_GLYPHS {
  return Object.prototype.hasOwnProperty.call(EXTENSION_KIND_GLYPHS, kind)
}

function extensionKindLabel(kind: string, copy: ReturnType<typeof pluginCopy>) {
  if (knownExtensionKind(kind)) {
    return copy.kind[kind]
  }
  return kind
    .split(/[-_.]+/)
    .filter(Boolean)
    .map(part => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ') || kind
}

function extensionKindGlyph(kind: string) {
  const Glyph = knownExtensionKind(kind) ? EXTENSION_KIND_GLYPHS[kind] : PuzzleGlyph
  return <Glyph />
}

function ExtensionIcon({ extension }: { extension: Pick<AgentExtension, 'icon' | 'iconDark' | 'kind'> }) {
  if (!extension.icon && !extension.iconDark) return <>{extensionKindGlyph(extension.kind)}</>
  const lightIcon = extension.icon || extension.iconDark || ''
  return <>
    <img className="code-plugin-manifest-icon light" src={lightIcon} alt="" />
    {extension.iconDark ? (
      <img className="code-plugin-manifest-icon dark" src={extension.iconDark} alt="" />
    ) : null}
  </>
}

function configurationSummaryLabel(
  key: AgentExtensionGroup['homes'][number]['configuration']['summary'][number]['key'],
  copy: ReturnType<typeof pluginCopy>,
) {
  return {
    approval: copy.approval,
    model: copy.model,
    permission: copy.permission,
    provider: copy.provider,
    reasoning: copy.reasoning,
    sandbox: copy.sandbox,
    serviceTier: copy.serviceTier,
  }[key]
}

function extensionKindTabLabel(kind: string, copy: ReturnType<typeof pluginCopy>) {
  if (knownExtensionKind(kind)) {
    return copy.kindTabs[kind]
  }
  return extensionKindLabel(kind, copy)
}

function agentConfigurationKey(provider: string, homeId: string) {
  return `${provider}:${homeId}`
}

function orderedAgentConfigurations(groups: AgentExtensionGroup[]): AgentConfiguration[] {
  return groups
    .flatMap(provider => provider.homes.map(home => ({ provider, home })))
    .sort((left, right) => (
      left.home.order - right.home.order
      || left.provider.id.localeCompare(right.provider.id)
      || left.home.id.localeCompare(right.home.id)
    ))
}

function safeExtensionIcon(value: unknown) {
  const icon = typeof value === 'string' ? value : ''
  return /^data:image\/(?:svg\+xml|png|webp|jpeg);base64,[A-Za-z0-9+/=]+$/.test(icon) ? icon : ''
}

function extensionRasterIconUrl(rootIdValue: unknown, pathValue: unknown) {
  const rootId = typeof rootIdValue === 'string' ? rootIdValue.trim() : ''
  const filePath = typeof pathValue === 'string' ? pathValue.trim().replace(/\\/g, '/') : ''
  if (
    !rootId
    || !filePath
    || filePath.startsWith('/')
    || filePath.split('/').includes('..')
    || !/\.(?:png|webp|jpe?g)$/i.test(filePath)
  ) return ''
  return appPath(`/api/files/raw?${new URLSearchParams({ rootId, path: filePath }).toString()}`)
}

function normalizeAgentExtensionGroups(rawGroups: AgentExtensionGroup[]): AgentExtensionGroup[] {
  let fallbackOrder = 0
  return rawGroups.map(provider => ({
    ...provider,
    available: provider.available !== false,
    acpExecutablePolicy: provider.acpExecutablePolicy === 'managed' ? 'managed' : 'system',
    launchDefaults: {
      homeId: String(provider.launchDefaults?.homeId || 'default'),
      runtimeMode: provider.supportsChat === true && provider.launchDefaults?.runtimeMode === 'chat'
        ? 'chat'
        : 'terminal',
    },
    supportsChat: provider.supportsChat === true,
    homes: (provider.homes || []).map(home => ({
      ...home,
      path: String(home.path || ''),
      order: Number.isFinite(Number(home.order)) ? Number(home.order) : fallbackOrder++,
      acpRuntime: { mode: 'managed', executable: '' },
      newAgentDefaults: {
        model: 'inherit',
        reasoning: 'inherit',
        fast: 'inherit',
      } satisfies NewAgentDefaults,
      configuration: {
        exists: home.configuration?.exists === true,
        filePath: String(home.configuration?.filePath || ''),
        rootId: String(home.configuration?.rootId || ''),
        summary: Array.isArray(home.configuration?.summary) ? home.configuration.summary : [],
      },
      extensions: Array.isArray(home.extensions) ? home.extensions.map(extension => {
        const status: AgentExtension['status'] = extension.status === 'enabled' || extension.status === 'disabled'
          ? extension.status
          : 'configured'
        const rootId = String(extension.rootId || home.configuration?.rootId || '')
        return {
          ...extension,
          id: String(extension.id || ''),
          name: String(extension.name || ''),
          description: String(extension.description || ''),
          kind: String(extension.kind || 'plugin'),
          scope: String(extension.scope || ''),
          status,
          sourceFile: String(extension.sourceFile || ''),
          rootId,
          icon: safeExtensionIcon(extension.icon) || extensionRasterIconUrl(rootId, extension.iconPath),
          iconDark: safeExtensionIcon(extension.iconDark) || extensionRasterIconUrl(rootId, extension.iconDarkPath),
        }
      }) : [],
    })),
  }))
}

function settingsHomes(groups: AgentExtensionGroup[]) {
  return Object.fromEntries(groups.map(provider => [
    provider.id,
    provider.homes.map(home => ({
      id: home.id,
      path: home.path,
      order: home.order,
      acpRuntime: { mode: 'managed', executable: '' },
      newAgentDefaults: { model: 'inherit', reasoning: 'inherit', fast: 'inherit' },
    })),
  ]))
}

function settingsLaunchProfiles(groups: AgentExtensionGroup[]) {
  return Object.fromEntries(groups.map(provider => [
    provider.id,
    {
      homeId: provider.launchDefaults.homeId,
      runtimeMode: provider.launchDefaults.runtimeMode,
    },
  ]))
}

function homeIdForPath(homePath: string) {
  const segments = homePath.trim().replace(/\/+$/, '').split('/').filter(Boolean)
  const segment = segments[segments.length - 1] || 'home'
  return segment
    .replace(/^\.+/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 64) || 'home'
}

export function PluginsPanel({
  capability,
  loading,
  capabilityError,
  computerCapability,
  computerLoading,
  computerCapabilityError,
  onPrepareComputer,
  language,
  navigationState,
  onNavigationStateChange,
  canNavigateBack,
  onNavigateHistory,
  onBack,
  onOpenAgentHomeConfiguration,
  onRefreshCapability,
}: {
  capability: BrowserCapability | null
  loading: boolean
  capabilityError: string
  computerCapability: ComputerCapability | null
  computerLoading: boolean
  computerCapabilityError: string
  onPrepareComputer: () => Promise<ComputerCapability>
  language: UiLanguage
  navigationState: PluginsNavigationState
  onNavigationStateChange: Dispatch<SetStateAction<PluginsNavigationState>>
  canNavigateBack: boolean
  onNavigateHistory: (direction: -1 | 1) => boolean
  onBack: () => void
  onOpenAgentHomeConfiguration: (target: AgentHomeFileTarget) => void
  onRefreshCapability: () => void
}) {
  const copy = useMemo(() => pluginCopy(language), [language])
  const isMacHost = typeof navigator !== 'undefined'
    && /Mac/.test(navigator.platform || navigator.userAgent)
  const dockerInstallUrl = isMacHost ? DOCKER_DESKTOP_MAC_INSTALL_URL : DOCKER_ENGINE_INSTALL_URL
  const dockerInstallLabel = isMacHost ? copy.installDockerDesktop : copy.viewDockerInstallGuide
  const [enabled, setEnabled] = useState(capability?.enabled === true)
  const [computerEnabled, setComputerEnabled] = useState(computerCapability?.enabled === true)
  const [computerCompatibilityMode, setComputerCompatibilityMode] = useState(
    computerCapability?.compatibilityMode === true,
  )
  const [computerSaving, setComputerSaving] = useState(false)
  const [computerPreparing, setComputerPreparing] = useState(false)
  const [computerError, setComputerError] = useState('')
  const [saving, setSaving] = useState(false)
  const [preparingBrowserExtension, setPreparingBrowserExtension] = useState(false)
  const [preparingIsolatedBrowser, setPreparingIsolatedBrowser] = useState(false)
  const [isolatedCompatibilityRequired, setIsolatedCompatibilityRequired] = useState(false)
  const [error, setError] = useState('')
  const [browserExtensionStatusError, setBrowserExtensionStatusError] = useState('')
  const [browserExtensionInstalled, setBrowserExtensionInstalled] = useState(
    capability?.extension?.installed === true,
  )
  const [browserExtensionConnected, setBrowserExtensionConnected] = useState(
    capability?.extension?.connected === true,
  )
  const [browserExtensionInfo, setBrowserExtensionInfo] = useState<BrowserExtensionCapability>(
    capability?.extension ?? {},
  )
  const [chromeExtensionsAddressCopied, setChromeExtensionsAddressCopied] = useState(false)
  const browserExtensionConnectedRef = useRef(capability?.extension?.connected === true)
  const [agentGroups, setAgentGroups] = useState<AgentExtensionGroup[]>([])
  const [agentGroupsLoading, setAgentGroupsLoading] = useState(true)
  const [agentGroupsError, setAgentGroupsError] = useState('')
  const [agentSaving, setAgentSaving] = useState(false)
  const [agentDraft, setAgentDraft] = useState<AgentHomeDraft | null>(null)
  const [draggingAgentKey, setDraggingAgentKey] = useState('')
  const selectedExtensionTriggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const activeTab = navigationState.activeTab
  const activeExtensionHomeKey = navigationState.activeExtensionHomeKey
  const activeExtensionKind = navigationState.activeExtensionKind
  const extensionQuery = navigationState.extensionQuery
  const updateNavigationState = useCallback((patch: Partial<PluginsNavigationState>) => {
    onNavigationStateChange(current => ({ ...current, ...patch }))
  }, [onNavigationStateChange])
  const setExtensionQuery = useCallback((value: string) => {
    updateNavigationState({ extensionQuery: value })
  }, [updateNavigationState])
  const [languageServerCapability, setLanguageServerCapability] = useState<LanguageServerCapability | null>(null)
  const [languageServerLoading, setLanguageServerLoading] = useState(true)
  const [languageServerError, setLanguageServerError] = useState('')
  const [languageServerExpanded, setLanguageServerExpanded] = useState(false)
  const [languageServerEnabled, setLanguageServerEnabled] = useState(true)
  const [languageServerSaving, setLanguageServerSaving] = useState(false)
  const [languageServerSaveError, setLanguageServerSaveError] = useState('')
  const agentSaveRequestRef = useRef<number | null>(null)
  const agentSaveSequenceRef = useRef(0)
  const retryOnReconnectRef = useRef(false)
  const agentLoadOwnershipRef = useRef(new RequestOwnershipFence('agent-home-panel'))
  const agentSaveOwnershipRef = useRef(new RequestOwnershipFence('agent-home-panel'))

  useEffect(() => {
    const scroller = panelRef.current?.closest<HTMLElement>('.code-plugins-view')
    if (!scroller || agentGroupsLoading) return undefined
    const restoreScroll = () => {
      scroller.scrollTop = navigationState.scrollTop
    }
    restoreScroll()
    const frame = window.requestAnimationFrame(restoreScroll)
    return () => window.cancelAnimationFrame(frame)
  }, [agentGroups.length, agentGroupsLoading, navigationState.scrollTop])

  useEffect(() => {
    const scroller = panelRef.current?.closest<HTMLElement>('.code-plugins-view')
    if (!scroller || agentGroupsLoading) return undefined
    let saveTimer: number | null = null
    const saveScroll = () => {
      saveTimer = null
      const scrollTop = scroller.scrollTop
      onNavigationStateChange(current => (
        scrollTop === current.scrollTop ? current : { ...current, scrollTop }
      ))
    }
    const handleScroll = () => {
      if (saveTimer !== null) window.clearTimeout(saveTimer)
      saveTimer = window.setTimeout(saveScroll, PLUGIN_SCROLL_SAVE_SETTLE_MS)
    }
    const finishScroll = () => {
      if (saveTimer === null) return
      window.clearTimeout(saveTimer)
      saveScroll()
    }
    scroller.addEventListener('scroll', handleScroll, { passive: true })
    window.addEventListener('pointerup', finishScroll, true)
    return () => {
      scroller.removeEventListener('scroll', handleScroll)
      window.removeEventListener('pointerup', finishScroll, true)
      if (saveTimer !== null) window.clearTimeout(saveTimer)
      saveScroll()
    }
  }, [agentGroupsLoading, onNavigationStateChange])

  const loadLanguageServerCapability = useCallback(async () => {
    setLanguageServerLoading(true)
    setLanguageServerError('')
    try {
      const nextCapability = await fetchLanguageServerCapability()
      setLanguageServerCapability(nextCapability)
      setLanguageServerEnabled(nextCapability.enabled !== false)
    } catch (loadError) {
      setLanguageServerCapability(null)
      setLanguageServerError(loadError instanceof Error ? loadError.message : copy.languageServerError)
    } finally {
      setLanguageServerLoading(false)
    }
  }, [copy.languageServerError])

  const toggleLanguageServer = async () => {
    if (languageServerSaving) return
    const nextEnabled = !languageServerEnabled
    setLanguageServerSaving(true)
    setLanguageServerSaveError('')
    try {
      const response = await fetch(appPath('/api/settings'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ languageServerEnabled: nextEnabled }),
      })
      const data = await response.json().catch(() => ({})) as {
        error?: string
        settings?: { languageServerEnabled?: boolean }
      }
      if (!response.ok) throw new Error(data.error || copy.languageServerSaveFailed)
      setLanguageServerEnabled(data.settings?.languageServerEnabled !== false)
      await loadLanguageServerCapability()
    } catch (caught) {
      setLanguageServerSaveError(caught instanceof Error ? caught.message : copy.languageServerSaveFailed)
    } finally {
      setLanguageServerSaving(false)
    }
  }

  useEffect(() => {
    void loadLanguageServerCapability()
  }, [loadLanguageServerCapability])

  useEffect(() => {
    if (!capability) return
    setEnabled(capability.enabled)
  }, [capability])

  useEffect(() => {
    if (activeTab !== 'farming') return
    let active = true
    let timer: number | undefined
    setBrowserExtensionStatusError('')
    const schedule = () => {
      if (!active || document.visibilityState !== 'visible') return
      timer = window.setTimeout(() => void load(), 2000)
    }
    const load = async () => {
      if (!active || document.visibilityState !== 'visible') return
      try {
        const response = await fetch(appPath('/api/browsers/extension'), { headers: { Accept: 'application/json' } })
        const data = await response.json().catch(() => ({})) as BrowserExtensionCapability & { error?: string }
        if (!response.ok) throw new Error(data.error || copy.extensionStatusFailed)
        if (!active) return
        setBrowserExtensionStatusError('')
        setBrowserExtensionInstalled(data.installed === true)
        setBrowserExtensionInfo(data)
        const connected = data.connected === true
        setBrowserExtensionConnected(connected)
        if (browserExtensionConnectedRef.current !== connected) {
          browserExtensionConnectedRef.current = connected
          onRefreshCapability()
        }
      } catch (caught) {
        if (active) setBrowserExtensionStatusError(
          caught instanceof Error ? caught.message : copy.extensionStatusFailed,
        )
      } finally {
        schedule()
      }
    }
    const handleVisibilityChange = () => {
      if (timer !== undefined) window.clearTimeout(timer)
      timer = undefined
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    void load()
    return () => {
      active = false
      if (timer !== undefined) window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [activeTab, copy.extensionStatusFailed, onRefreshCapability])

  useEffect(() => {
    if (!computerCapability) return
    setComputerEnabled(computerCapability.enabled)
    setComputerCompatibilityMode(computerCapability.compatibilityMode)
  }, [computerCapability])

  const loadAgentGroups = useCallback(async (options: { preserveError?: boolean } = {}) => {
    if (!agentLoadOwnershipRef.current.available || agentSaveRequestRef.current) return
    const lease = agentLoadOwnershipRef.current.begin()
    retryOnReconnectRef.current = false
    setAgentGroupsLoading(true)
    if (!options.preserveError) setAgentGroupsError('')
    try {
      const response = await fetchAgentSettings(appPath('/api/agent-extensions'), {
        headers: { Accept: 'application/json' },
      })
      const data = await response.json().catch(() => ({})) as {
        agents?: AgentExtensionGroup[]
        error?: string
      }
      if (!response.ok) throw new Error(data.error || copy.agentExtensionsFailed)
      if (
        !lease.isCurrent()
        || agentSaveRequestRef.current
      ) return
      retryOnReconnectRef.current = false
      const nextGroups = normalizeAgentExtensionGroups(Array.isArray(data.agents) ? data.agents : [])
      setAgentGroups(nextGroups)
    } catch (loadError) {
      if (
        !lease.isCurrent()
        || agentSaveRequestRef.current
      ) return
      const disconnected = !getBackendConnectionSnapshot().connected
      retryOnReconnectRef.current = disconnected
      setAgentGroupsError(disconnected
        ? copy.agentExtensionsDisconnected
        : loadError instanceof Error ? loadError.message : copy.agentExtensionsFailed)
    } finally {
      if (
        lease.isCurrent()
        && !agentSaveRequestRef.current
      ) setAgentGroupsLoading(false)
    }
  }, [copy.agentExtensionsDisconnected, copy.agentExtensionsFailed])

  useEffect(() => {
    const loadOwnership = agentLoadOwnershipRef.current
    const saveOwnership = agentSaveOwnershipRef.current
    loadOwnership.setMounted(true)
    saveOwnership.setMounted(true)
    const retryLoad = () => {
      if (!retryOnReconnectRef.current) return
      retryOnReconnectRef.current = false
      void loadAgentGroups()
    }
    window.addEventListener('farming:backend-connected', retryLoad)
    return () => {
      loadOwnership.setMounted(false)
      saveOwnership.setMounted(false)
      retryOnReconnectRef.current = false
      window.removeEventListener('farming:backend-connected', retryLoad)
    }
  }, [loadAgentGroups])

  useEffect(() => {
    void loadAgentGroups()
  }, [loadAgentGroups])

  const saveAgentGroups = useCallback(async (nextGroups: AgentExtensionGroup[]) => {
    if (!agentSaveOwnershipRef.current.available || agentSaveRequestRef.current) return false
    const lease = agentSaveOwnershipRef.current.begin()
    const requestId = agentSaveSequenceRef.current + 1
    agentSaveSequenceRef.current = requestId
    agentSaveRequestRef.current = requestId
    agentLoadOwnershipRef.current.invalidate()
    setAgentSaving(true)
    setAgentGroupsLoading(false)
    setAgentGroupsError('')
    let reconcileAfterSave = false
    try {
      const response = await fetchAgentSettings(appPath('/api/settings'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          agentHomes: settingsHomes(nextGroups),
          agentLaunchProfiles: settingsLaunchProfiles(nextGroups),
        }),
      })
      const data = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(data.error || copy.saveAgentFailed)
      if (
        agentSaveRequestRef.current !== requestId
        || !lease.isCurrent()
      ) return false
      setAgentGroups(nextGroups)
      window.dispatchEvent(new CustomEvent('farming-agent-homes-saved'))
      agentSaveRequestRef.current = null
      await loadAgentGroups()
      return true
    } catch (saveError) {
      reconcileAfterSave = true
      if (
        agentSaveRequestRef.current === requestId
        && lease.isCurrent()
      ) setAgentGroupsError(saveError instanceof Error ? saveError.message : copy.saveAgentFailed)
      return false
    } finally {
      if (agentSaveRequestRef.current === requestId) agentSaveRequestRef.current = null
      if (
        lease.isCurrent()
      ) {
        setAgentSaving(false)
        if (reconcileAfterSave) void loadAgentGroups({ preserveError: true })
      }
    }
  }, [copy.saveAgentFailed, loadAgentGroups])

  const submitAgentDraft = useCallback(() => {
    if (!agentDraft || agentSaving) return
    const providerId = agentDraft.provider
    const provider = agentGroups.find(group => group.id === providerId)
    const homePath = agentDraft.path.trim()
    const homeId = (agentDraft.id.trim() || homeIdForPath(homePath)).slice(0, 64)
    if (
      !provider
      || !homePath
      || !/^[A-Za-z0-9._-]+$/.test(homeId)
      || provider.homes.some(home => home.id.toLowerCase() === homeId.toLowerCase())
    ) {
      setAgentGroupsError(copy.invalidHome)
      return
    }
    const nextOrder = orderedAgentConfigurations(agentGroups)
      .reduce((maximum, configuration) => Math.max(maximum, configuration.home.order), -1) + 1
    const nextGroups = agentGroups.map(group => group.id === providerId
      ? {
          ...group,
          homes: [...group.homes, {
            id: homeId,
            path: homePath,
            order: nextOrder,
            acpRuntime: { mode: 'managed', executable: '' } satisfies AgentExtensionGroup['homes'][number]['acpRuntime'],
            newAgentDefaults: {
              model: 'inherit',
              reasoning: 'inherit',
              fast: 'inherit',
            } satisfies NewAgentDefaults,
            configuration: {
              exists: false,
              filePath: '',
              rootId: '',
              summary: [],
            },
            extensions: [],
          }],
        }
      : group)
    void saveAgentGroups(nextGroups).then(saved => {
      if (saved) setAgentDraft(null)
    })
  }, [agentDraft, agentGroups, agentSaving, copy.invalidHome, saveAgentGroups])

  const removeAgentConfiguration = useCallback((providerId: string, homeId: string) => {
    if (homeId === 'default' || agentSaving) return
    const label = `${agentDisplayName({ id: providerId, name: providerId })} · ${homeId}`
    const currentProvider = agentGroups.find(provider => provider.id === providerId)
    const removesLaunchDefault = currentProvider?.launchDefaults.homeId === homeId
    if (!window.confirm(removesLaunchDefault
      ? copy.confirmRemoveDefaultAgent(label)
      : copy.confirmRemoveAgent(label))) return
    const nextGroups = agentGroups.map(provider => provider.id === providerId
      ? {
          ...provider,
          launchDefaults: removesLaunchDefault
            ? { ...provider.launchDefaults, homeId: 'default' }
            : provider.launchDefaults,
          homes: provider.homes.filter(home => home.id !== homeId),
        }
      : provider)
    void saveAgentGroups(nextGroups)
  }, [agentGroups, agentSaving, copy, saveAgentGroups])

  const setLaunchDefaultHome = useCallback((providerId: string, homeId: string) => {
    if (agentSaving) return
    const nextGroups = agentGroups.map(provider => provider.id === providerId
      ? { ...provider, launchDefaults: { ...provider.launchDefaults, homeId } }
      : provider)
    void saveAgentGroups(nextGroups)
  }, [agentGroups, agentSaving, saveAgentGroups])

  const setLaunchDefaultRuntime = useCallback((providerId: string, runtimeMode: 'terminal' | 'chat') => {
    if (agentSaving) return
    const nextGroups = agentGroups.map(provider => provider.id === providerId
      ? { ...provider, launchDefaults: { ...provider.launchDefaults, runtimeMode } }
      : provider)
    void saveAgentGroups(nextGroups)
  }, [agentGroups, agentSaving, saveAgentGroups])

  const reorderAgentConfigurations = useCallback((sourceKey: string, targetKey: string) => {
    if (!sourceKey || sourceKey === targetKey || agentSaving) return
    const ordered = orderedAgentConfigurations(agentGroups)
    const sourceIndex = ordered.findIndex(configuration => (
      agentConfigurationKey(configuration.provider.id, configuration.home.id) === sourceKey
    ))
    const targetIndex = ordered.findIndex(configuration => (
      agentConfigurationKey(configuration.provider.id, configuration.home.id) === targetKey
    ))
    if (sourceIndex < 0 || targetIndex < 0) return
    const [source] = ordered.splice(sourceIndex, 1)
    if (!source) return
    ordered.splice(targetIndex, 0, source)
    const orderByKey = new Map(ordered.map((configuration, order) => [
      agentConfigurationKey(configuration.provider.id, configuration.home.id),
      order,
    ]))
    const nextGroups = agentGroups.map(provider => ({
      ...provider,
      homes: provider.homes.map(home => ({
        ...home,
        order: orderByKey.get(agentConfigurationKey(provider.id, home.id)) ?? home.order,
      })),
    }))
    setAgentGroups(nextGroups)
    void saveAgentGroups(nextGroups)
  }, [agentGroups, agentSaving, saveAgentGroups])

  const moveAgentConfiguration = useCallback((key: string, offset: -1 | 1) => {
    const ordered = orderedAgentConfigurations(agentGroups)
    const index = ordered.findIndex(configuration => (
      agentConfigurationKey(configuration.provider.id, configuration.home.id) === key
    ))
    const target = ordered[index + offset]
    if (index < 0 || !target) return
    reorderAgentConfigurations(
      key,
      agentConfigurationKey(target.provider.id, target.home.id),
    )
  }, [agentGroups, reorderAgentConfigurations])

  const toggleBrowser = async () => {
    if (saving || (!capability?.browser && !enabled)) return
    const nextEnabled = !enabled
    setSaving(true)
    setError('')
    try {
      const response = await fetch(appPath('/api/settings'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ browserExtensionEnabled: nextEnabled }),
      })
      const data = await response.json().catch(() => ({})) as {
        error?: string
        settings?: { browserExtensionEnabled?: boolean }
      }
      if (!response.ok) throw new Error(data.error || copy.saveFailed)
      setEnabled(data.settings?.browserExtensionEnabled === true)
      onRefreshCapability()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : copy.saveFailed)
    } finally {
      setSaving(false)
    }
  }

  const prepareIsolatedBrowser = async () => {
    if (preparingIsolatedBrowser) return
    setPreparingIsolatedBrowser(true)
    setIsolatedCompatibilityRequired(false)
    setError('')
    try {
      const response = await fetch(appPath('/api/browsers/isolated/prepare'), {
        method: 'POST',
        headers: { Accept: 'application/json' },
      })
      const data = await response.json().catch(() => ({})) as {
        compatibilityRequired?: boolean
        error?: string
      }
      if (!response.ok) {
        setIsolatedCompatibilityRequired(data.compatibilityRequired === true)
        throw new Error(data.error || copy.isolatedBrowserPrepareFailed)
      }
      onRefreshCapability()
    } catch (prepareError) {
      setError(prepareError instanceof Error ? prepareError.message : copy.isolatedBrowserPrepareFailed)
      onRefreshCapability()
    } finally {
      setPreparingIsolatedBrowser(false)
    }
  }

  const updateBrowserExtensionDirectory = async () => {
    if (preparingBrowserExtension) return
    const remove = browserExtensionInstalled
    if (remove && !window.confirm(copy.confirmRemoveConnectorDirectory)) return
    setPreparingBrowserExtension(true)
    setError('')
    try {
      const response = await fetch(appPath('/api/browsers/extension/prepare'), {
        method: remove ? 'DELETE' : 'POST',
        headers: { Accept: 'application/json' },
      })
      const data = await response.json().catch(() => ({})) as BrowserExtensionCapability & { error?: string }
      if (!response.ok) throw new Error(data.error || (
        remove ? copy.connectorRemoveFailed : copy.connectorPrepareFailed
      ))
      setBrowserExtensionInstalled(data.installed === true)
      setBrowserExtensionInfo(data)
      onRefreshCapability()
    } catch (prepareError) {
      setError(prepareError instanceof Error ? prepareError.message : (
        remove ? copy.connectorRemoveFailed : copy.connectorPrepareFailed
      ))
    } finally {
      setPreparingBrowserExtension(false)
    }
  }

  const copyChromeExtensionsAddress = async () => {
    try {
      if (!navigator.clipboard) throw new Error(copy.connectorCopyFailed)
      await navigator.clipboard.writeText(CHROME_EXTENSIONS_ADDRESS)
      setChromeExtensionsAddressCopied(true)
      window.setTimeout(() => setChromeExtensionsAddressCopied(false), 1600)
    } catch {
      setError(copy.connectorCopyFailed)
    }
  }

  const saveComputerSettings = async (patch: {
    computerCompatibilityMode?: boolean
    computerExtensionEnabled?: boolean
  }) => {
    if (computerSaving) return
    setComputerSaving(true)
    setComputerError('')
    try {
      const response = await fetch(appPath('/api/settings'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(patch),
      })
      const data = await response.json().catch(() => ({})) as {
        error?: string
        settings?: {
          computerCompatibilityMode?: boolean
          computerExtensionEnabled?: boolean
        }
      }
      if (!response.ok) throw new Error(data.error || copy.computerSaveFailed)
      setComputerEnabled(data.settings?.computerExtensionEnabled === true)
      setComputerCompatibilityMode(data.settings?.computerCompatibilityMode === true)
      onRefreshCapability()
    } catch (caught) {
      setComputerError(caught instanceof Error ? caught.message : copy.computerSaveFailed)
    } finally {
      setComputerSaving(false)
    }
  }

  const prepareComputer = async () => {
    if (computerPreparing) return
    setComputerPreparing(true)
    setComputerError('')
    try {
      await onPrepareComputer()
      onRefreshCapability()
    } catch (caught) {
      setComputerError(caught instanceof Error ? caught.message : copy.computerPrepareFailed)
      onRefreshCapability()
    } finally {
      setComputerPreparing(false)
    }
  }

  const browserReady = capability?.sources?.some(source => source.available)
    ?? Boolean(capability?.browser)
  const systemBrowserReady = (capability?.sources || []).some(source => (
    source.source === 'system' && source.available
  ))
  const isolatedBrowserReady = capability?.isolated?.imageReady === true
  const isolatedBrowserDockerAvailable = capability?.isolated?.dockerAvailable === true
  const showIsolatedBrowserPrepare = !isolatedBrowserReady
    && isolatedBrowserDockerAvailable
  const isolatedBrowserStatus = isolatedBrowserReady
    ? copy.ready
    : capability?.isolated?.dockerAvailable === false
      ? copy.dockerRequired
      : copy.notInstalled
  const languageServerRuntimeLanguages = languageServerLanguages(languageServerCapability)
  const languageServerHasRuntimeInventory = Array.isArray(languageServerCapability?.languages)
  const languageServerCounts = languageServerRuntimeLanguages.reduce<Record<LanguageServerRuntimeStatus, number>>((counts, item) => {
    counts[item.status] += 1
    return counts
  }, { running: 0, available: 0, installable: 0, missing: 0 })
  const importantLanguageServerLanguages = languageServerRuntimeLanguages.filter(item => item.status !== 'missing')
  const missingLanguageServerLanguages = languageServerRuntimeLanguages.filter(item => item.status === 'missing')
  const collapsedLanguageServerLanguages = [
    ...importantLanguageServerLanguages,
    ...missingLanguageServerLanguages.slice(0, Math.max(0, 7 - importantLanguageServerLanguages.length)),
  ]
  const visibleLanguageServerLanguages = languageServerExpanded
    ? languageServerRuntimeLanguages
    : collapsedLanguageServerLanguages
  const hiddenLanguageServerLanguageCount = languageServerRuntimeLanguages.length - visibleLanguageServerLanguages.length
  const languageServerCanExpand = collapsedLanguageServerLanguages.length < languageServerRuntimeLanguages.length
  const languageServerStatus = languageServerLoading
    ? copy.languageServerChecking
    : languageServerError || languageServerCapability?.status === 'error'
      ? copy.languageServerError
      : !languageServerEnabled
        ? copy.disabled
        : languageServerCapability && !languageServerHasRuntimeInventory
          ? copy.languageServerRestartRequired
          : languageServerRuntimeLanguages.length > 0
            ? copy.languageServerSummary(languageServerCounts)
            : copy.languageServerUnavailable
  const status = loading && capability === null
    ? copy.checking
    : capabilityError
      ? copy.checkFailed
    : browserReady
      ? enabled ? copy.enabled : copy.disabled
      : copy.unavailable
  const computerStatus = computerLoading && computerCapability === null
    ? copy.checking
    : computerCapabilityError
      ? copy.checkFailed
    : !computerCapability?.dockerAvailable
      ? copy.dockerUnavailable
      : computerCapability.imageReady
        ? computerEnabled ? copy.enabled : copy.disabled
        : copy.computerRuntimeMissing
  const agentConfigurations = useMemo(() => orderedAgentConfigurations(agentGroups), [agentGroups])
  const extensionHomes = useMemo(() => agentConfigurations.map(({ provider, home }) => {
    const homeKey = agentConfigurationKey(provider.id, home.id)
    return {
      key: homeKey,
      domId: `${provider.id}-${home.id}`,
      label: `${agentDisplayName(provider)} · ${home.id}`,
      extensions: home.extensions.map(extension => ({
        ...extension,
        agentName: `${agentDisplayName(provider)} · ${home.id}`,
        homeKey,
        homeId: home.id,
        homePath: home.path,
      })),
    }
  }), [agentConfigurations])
  const selectedExtensionHome = extensionHomes.find(home => home.key === activeExtensionHomeKey)
    || extensionHomes[0]
  const agentExtensions = useMemo(
    () => extensionHomes.flatMap(home => home.extensions),
    [extensionHomes],
  )
  const selectedExtension = useMemo(() => {
    const selected = navigationState.selectedExtension
    if (!selected) return null
    return agentExtensions.find(extension => (
      extension.homeKey === selected.homeKey
      && extension.id === selected.id
      && extension.sourceFile === selected.sourceFile
    )) || null
  }, [agentExtensions, navigationState.selectedExtension])
  const extensionKindCounts = useMemo(() => {
    const counts = new Map<string, number>()
    selectedExtensionHome?.extensions.forEach(extension => {
      counts.set(extension.kind, (counts.get(extension.kind) || 0) + 1)
    })
    return counts
  }, [selectedExtensionHome])
  const extensionKinds = useMemo(() => {
    const extras = [...extensionKindCounts.keys()]
      .filter(kind => !EXTENSION_KIND_ORDER.includes(kind))
      .sort((left, right) => left.localeCompare(right))
    return [...EXTENSION_KIND_ORDER, ...extras].map(kind => ({
      kind,
      count: extensionKindCounts.get(kind) || 0,
    }))
  }, [extensionKindCounts])
  const selectedExtensionKind = extensionKindCounts.get(activeExtensionKind)
    ? activeExtensionKind
    : extensionKinds.find(kind => kind.count > 0)?.kind || activeExtensionKind
  const filteredAgentExtensions = useMemo(() => {
    const query = extensionQuery.trim().toLocaleLowerCase()
    const extensions = (selectedExtensionHome?.extensions || [])
      .filter(extension => extension.kind === selectedExtensionKind)
    if (!query) return extensions
    return extensions.filter(extension => [
      extension.name,
      extension.description,
      extension.sourceFile,
      extension.kind,
      extension.scope,
      extension.agentName,
    ].some(value => value.toLocaleLowerCase().includes(query)))
  }, [extensionQuery, selectedExtensionHome, selectedExtensionKind])

  const handleExtensionHomeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const selectedIndex = extensionHomes.findIndex(home => home.key === selectedExtensionHome?.key)
    let nextIndex = selectedIndex
    if (event.key === 'ArrowRight') nextIndex = (selectedIndex + 1) % extensionHomes.length
    else if (event.key === 'ArrowLeft') nextIndex = (selectedIndex - 1 + extensionHomes.length) % extensionHomes.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = extensionHomes.length - 1
    else return
    const nextHome = extensionHomes[nextIndex]
    if (!nextHome) return
    event.preventDefault()
    updateNavigationState({ activeExtensionHomeKey: nextHome.key, extensionQuery: '' })
    window.requestAnimationFrame(() => {
      document.getElementById(`code-plugin-extension-home-${nextHome.domId}`)?.focus()
    })
  }, [extensionHomes, selectedExtensionHome?.key, updateNavigationState])

  const handleExtensionKindKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const availableKinds = extensionKinds.filter(kind => kind.count > 0)
    const selectedIndex = availableKinds.findIndex(kind => kind.kind === selectedExtensionKind)
    let nextIndex = selectedIndex
    if (event.key === 'ArrowRight') nextIndex = (selectedIndex + 1) % availableKinds.length
    else if (event.key === 'ArrowLeft') nextIndex = (selectedIndex - 1 + availableKinds.length) % availableKinds.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = availableKinds.length - 1
    else return
    const nextKind = availableKinds[nextIndex]
    if (!nextKind) return
    event.preventDefault()
    updateNavigationState({ activeExtensionKind: nextKind.kind, extensionQuery: '' })
    window.requestAnimationFrame(() => {
      document.getElementById(`code-plugin-extension-kind-${nextKind.kind}`)?.focus()
    })
  }, [extensionKinds, selectedExtensionKind, updateNavigationState])

  const activateTab = useCallback((tab: PluginsTab) => {
    updateNavigationState({ activeTab: tab, selectedExtension: null })
  }, [updateNavigationState])

  const closeSelectedExtension = useCallback(() => {
    updateNavigationState({ selectedExtension: null })
    window.requestAnimationFrame(() => {
      const trigger = selectedExtensionTriggerRef.current
      if (trigger?.isConnected) trigger.focus({ preventScroll: true })
    })
  }, [updateNavigationState])

  const handleTabKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const currentIndex = PLUGINS_TABS.indexOf(activeTab)
    let nextIndex = currentIndex
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % PLUGINS_TABS.length
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + PLUGINS_TABS.length) % PLUGINS_TABS.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = PLUGINS_TABS.length - 1
    else return
    event.preventDefault()
    const nextTab = PLUGINS_TABS[nextIndex]
    if (!nextTab) return
    activateTab(nextTab)
    window.requestAnimationFrame(() => {
      document.getElementById(`code-plugin-tab-${nextTab}`)?.focus()
    })
  }, [activeTab, activateTab])

  return (
    <div ref={panelRef} className="code-plugins-panel" data-testid="code-plugins-panel">
      <header className="code-plugins-panel-header">
        <button
          type="button"
          onClick={() => {
            if (!canNavigateBack || !onNavigateHistory(-1)) onBack()
          }}
          aria-label={copy.goBack}
          title={copy.goBack}
          data-testid="code-plugin-history-back"
        >
          <ArrowLeftGlyph />
        </button>
        <div>
          <h2>{copy.title}</h2>
          <p>{copy.description}</p>
        </div>
      </header>

      <div className="code-plugin-tabs" role="tablist" aria-label={copy.title}>
        {PLUGINS_TABS.map(tab => {
          let count: number | string
          if (tab === 'farming') count = farmingBuiltinExtensionCount(Boolean(window.farmingDesktop))
          else if (agentGroupsError) count = '!'
          else if (agentGroupsLoading && agentGroups.length === 0) count = '…'
          else if (tab === 'homes') count = agentConfigurations.length
          else count = agentExtensions.length
          return (
            <button
              id={`code-plugin-tab-${tab}`}
              key={tab}
              type="button"
              role="tab"
              data-testid={`code-plugin-tab-${tab}`}
              aria-selected={activeTab === tab}
              aria-controls={`code-plugin-panel-${tab}`}
              tabIndex={activeTab === tab ? 0 : -1}
              onClick={() => activateTab(tab)}
              onKeyDown={handleTabKeyDown}
            >
              <span>{copy.tabs[tab]}</span>
              <small>{count}</small>
            </button>
          )
        })}
      </div>

      {activeTab === 'farming' ? <section
        id="code-plugin-panel-farming"
        className="code-plugin-section code-plugin-tab-panel"
        data-testid="code-plugin-section-farming"
        role="tabpanel"
        aria-labelledby="code-plugin-tab-farming"
      >
        <header className="code-plugin-section-header">
          <div>
            <h3>{copy.farmingBuiltIn}</h3>
            <p>{copy.farmingBuiltInDescription}</p>
          </div>
        </header>
        {window.farmingDesktop ? <DesktopConnectionsPanel language={language} /> : null}
        <article className="code-plugin-card" data-testid="code-plugin-browser">
          <span className="code-plugin-card-icon" aria-hidden="true">
            <BrowserGlyph />
          </span>
          <div className="code-plugin-card-copy">
            <div className="code-plugin-card-title">
              <h3>{copy.browser}</h3>
              <span className={`code-plugin-status ${browserReady && enabled ? 'enabled' : ''}`}>{status}</span>
            </div>
            <p>{copy.browserDescription}</p>
            <div className="code-plugin-browser-sources" role="group" aria-label={copy.browserChoice}>
              <div className="code-plugin-browser-source">
                <div className="code-plugin-browser-source-copy">
                  <span className="code-plugin-browser-source-heading">
                    <strong>{copy.newBrowser}</strong>
                    <small>{systemBrowserReady ? copy.ready : copy.unavailable}</small>
                  </span>
                  <small>{systemBrowserReady ? copy.newBrowserDescription : copy.noSystemBrowser}</small>
                </div>
              </div>
              <div className="code-plugin-browser-source">
                <div className="code-plugin-browser-source-copy">
                  <span className="code-plugin-browser-source-heading">
                    <strong>{copy.extensionBrowser}</strong>
                    <small>{browserExtensionConnected ? copy.ready : copy.notReady}</small>
                  </span>
                  <small>{copy.extensionBrowserDescription}</small>
                  {(browserExtensionInstalled || browserExtensionInfo.integrity === 'invalid')
                    && browserExtensionInfo.extensionPath ? (
                    <div className="code-plugin-browser-connector-details" data-testid="browser-connector-details">
                      <small>{copy.connectorReadyHint}</small>
                      <div>
                        <span>{copy.connectorExtensionsPage}</span>
                        <button
                          type="button"
                          className="code-plugin-browser-copy-address"
                          onClick={() => void copyChromeExtensionsAddress()}
                        >
                          <code>{CHROME_EXTENSIONS_ADDRESS}</code>
                          <span>{chromeExtensionsAddressCopied
                            ? copy.connectorAddressCopied
                            : copy.connectorCopyAddress}</span>
                        </button>
                      </div>
                      <div>
                        <span>{copy.connectorDirectory}</span>
                        <code
                          data-testid="browser-connector-directory"
                          title={browserExtensionInfo.extensionPath}
                        >{browserExtensionInfo.extensionPath}</code>
                      </div>
                      <div className="code-plugin-browser-connector-metadata">
                        <span>{copy.connectorSize}</span>
                        <strong>{formatByteSize(browserExtensionInfo.sizeBytes)}</strong>
                        <span>{copy.connectorIntegrity}</span>
                        <strong className={browserExtensionInfo.integrity === 'valid' ? 'valid' : 'invalid'}>
                          {copy.connectorIntegrityValue[browserExtensionInfo.integrity ?? 'invalid']}
                        </strong>
                      </div>
                    </div>
                  ) : null}
                </div>
                {!browserExtensionConnected ? <div className="code-plugin-browser-source-actions">
                    <button
                      type="button"
                      className="code-plugin-browser-install"
                      disabled={preparingBrowserExtension}
                      onClick={() => void updateBrowserExtensionDirectory()}
                    >{preparingBrowserExtension
                        ? browserExtensionInstalled
                          ? copy.removingConnector
                          : copy.preparingConnector
                        : browserExtensionInstalled
                          ? copy.removeConnectorDirectory
                          : copy.prepareConnectorDirectory}</button>
                    <a
                      className="code-plugin-browser-install"
                      href={FARMING_BROWSER_DOCS_URL[language]}
                      target="_blank"
                      rel="noreferrer"
                    >{copy.connectorGuide}</a>
                </div> : null}
              </div>
              <div className="code-plugin-browser-source">
                <div className="code-plugin-browser-source-copy">
                  <span className="code-plugin-browser-source-heading">
                    <strong>{copy.isolatedBrowser}</strong>
                    <small>{isolatedBrowserStatus}</small>
                  </span>
                  <small>{copy.isolatedBrowserDescription}</small>
                </div>
                {showIsolatedBrowserPrepare || capability?.isolated?.dockerAvailable === false ? (
                  <div className="code-plugin-browser-source-actions">
                    {showIsolatedBrowserPrepare ? <button
                      type="button"
                      className="code-plugin-browser-install"
                      disabled={loading || preparingIsolatedBrowser}
                      onClick={() => void prepareIsolatedBrowser()}
                    >{preparingIsolatedBrowser ? copy.preparingIsolatedBrowser : copy.prepareIsolatedBrowser}</button> : null}
                    {capability?.isolated?.dockerAvailable === false ? <a
                      className="code-plugin-browser-install"
                      href={dockerInstallUrl}
                      target="_blank"
                      rel="noreferrer"
                    >{copy.installDocker}</a> : null}
                  </div>
                ) : null}
              </div>
            </div>
            {browserExtensionStatusError ? (
              <div className="code-plugin-error" role="alert">{browserExtensionStatusError}</div>
            ) : null}
            {isolatedCompatibilityRequired ? (
              <div className="code-plugin-computer-settings">
                <small>{copy.isolatedCompatibilityRequired}</small>
                <label>
                  <input
                    type="checkbox"
                    checked={computerCompatibilityMode}
                    disabled={computerLoading || computerSaving || computerPreparing || computerEnabled}
                    onChange={event => {
                      const next = event.currentTarget.checked
                      setComputerCompatibilityMode(next)
                      void saveComputerSettings({ computerCompatibilityMode: next })
                    }}
                  />
                  <span>{copy.compatibilityMode}</span>
                </label>
                <small>{copy.compatibilityHint}</small>
              </div>
            ) : null}
            {(error || capabilityError || (capability?.isolated?.dockerAvailable !== false && capability?.isolated?.error)) && (
              <div className="code-plugin-error" role="alert">
                {error || (capabilityError ? copy.browserCheckFailed : '') || capability?.isolated?.error}
              </div>
            )}
          </div>
          <button
            type="button"
            className={`code-plugin-toggle ${enabled ? 'active' : ''}`}
            aria-pressed={capabilityError ? false : enabled}
            disabled={Boolean(capabilityError) || loading || saving || preparingIsolatedBrowser || (!browserReady && !enabled)}
            onClick={() => void toggleBrowser()}
          >
            {loading && capability === null ? copy.checking : capabilityError ? copy.checkFailed : enabled ? copy.disable : copy.enable}
          </button>
        </article>
        <article className="code-plugin-card" data-testid="code-plugin-computer">
          <span className="code-plugin-card-icon" aria-hidden="true">
            <ComputerUseGlyph />
          </span>
          <div className="code-plugin-card-copy">
            <div className="code-plugin-card-title">
              <h3>{copy.computer}</h3>
              <span className={`code-plugin-status ${computerCapability?.imageReady && computerEnabled ? 'enabled' : ''}`}>
                {computerStatus}
              </span>
            </div>
            <p>{copy.computerDescription}</p>
            <div className="code-plugin-desktop-targets">
              <strong>{copy.desktopTargets}</strong>
              <div className="code-plugin-desktop-target">
                <div>
                  <span>{copy.isolatedDesktop}</span>
                  <small>{copy.isolatedDesktopDescription}</small>
                </div>
              </div>
            </div>
            <div className="code-plugin-computer-settings">
              <label>
                <input
                  type="checkbox"
                  checked={computerCompatibilityMode}
                  disabled={computerLoading || computerSaving || computerPreparing || computerEnabled}
                  onChange={event => {
                    const next = event.currentTarget.checked
                    setComputerCompatibilityMode(next)
                    void saveComputerSettings({ computerCompatibilityMode: next })
                  }}
                />
                <span>{copy.compatibilityMode}</span>
              </label>
              <small>{copy.compatibilityHint}</small>
              {!computerCapability?.imageReady && (
                <button
                  type="button"
                  disabled={computerLoading || computerPreparing || computerSaving || !computerCapability?.dockerAvailable}
                  onClick={() => void prepareComputer()}
                >
                  {computerPreparing ? copy.preparingComputer : copy.prepareComputer}
                </button>
              )}
            </div>
            <small>{copy.computerRuntimeHint}</small>
            {computerCapability?.dockerAvailable === false ? <small>
              {isMacHost ? copy.dockerMacGuidance : copy.dockerHostGuidance}{' '}
              <a className="code-plugin-help-link" href={dockerInstallUrl} target="_blank" rel="noreferrer">
                {dockerInstallLabel}
              </a>
            </small> : null}
            {(computerError || computerCapabilityError) && (
              <div className="code-plugin-error" role="alert">
                {computerError || (computerCapabilityError ? copy.computerCheckFailed : '')}
              </div>
            )}
          </div>
          <button
            type="button"
            className={`code-plugin-toggle ${computerEnabled ? 'active' : ''}`}
            aria-pressed={computerCapabilityError ? false : computerEnabled}
            disabled={
              Boolean(computerCapabilityError)
              || computerLoading
              || computerSaving
              || computerPreparing
              || (!computerCapability?.imageReady && !computerEnabled)
            }
            onClick={() => void saveComputerSettings({
              computerExtensionEnabled: !computerEnabled,
            })}
          >
            {computerLoading && computerCapability === null ? copy.checking : computerCapabilityError ? copy.checkFailed : computerEnabled ? copy.disable : copy.enable}
          </button>
        </article>
        <article className="code-plugin-card code-plugin-language-server-card" data-testid="code-plugin-language-server">
          <span className="code-plugin-card-icon" aria-hidden="true">
            <LanguageServerGlyph />
          </span>
          <div className="code-plugin-card-copy">
            <div className="code-plugin-card-title">
              <h3>{copy.languageServer}</h3>
              <span className="code-plugin-status">
                {languageServerStatus}
              </span>
            </div>
            {languageServerRuntimeLanguages.length > 0 && !languageServerError ? (
              <div className="code-plugin-language-server-table-shell">
                <div className="code-plugin-language-server-table-scroll">
                  <table className="code-plugin-language-server-table">
                    <thead>
                      <tr>
                        <th>{copy.languageServerLanguage}</th>
                        <th>{copy.languageServer}</th>
                        <th>{copy.languageServerStatus}</th>
                        <th>{copy.languageServerProject}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleLanguageServerLanguages.map(languageServer => {
                        const projectPaths = languageServer.projects.map(languageServerPath)
                        const projectNames = languageServer.projects.map(languageServerProjectName)
                        return <tr
                          key={languageServer.id}
                          data-testid={`code-plugin-language-server-language-${languageServer.id}`}
                        >
                          <td className="code-plugin-language-server-language">{languageServer.language}</td>
                          <td className="code-plugin-language-server-command">{languageServer.server}</td>
                          <td>
                            <span className={`code-plugin-language-server-runtime-status ${languageServer.status}`}>
                              {languageServer.status === 'running' ? <span aria-hidden="true" /> : null}
                              {copy.languageServerRuntimeStatus[languageServer.status]}
                            </span>
                          </td>
                          <td
                            className="code-plugin-language-server-projects"
                            title={projectPaths.join('\n')}
                          >{projectNames.join(', ') || '—'}</td>
                        </tr>
                      })}
                    </tbody>
                  </table>
                </div>
                {languageServerCanExpand ? (
                  <div className="code-plugin-language-server-table-footer">
                    <span>{languageServerExpanded
                      ? copy.languageServerTotal(languageServerRuntimeLanguages.length)
                      : copy.languageServerMore(hiddenLanguageServerLanguageCount)}</span>
                    <button
                      type="button"
                      onClick={() => setLanguageServerExpanded(expanded => !expanded)}
                    >{languageServerExpanded ? copy.languageServerCollapse : copy.languageServerShowAll}</button>
                  </div>
                ) : null}
              </div>
            ) : null}
            {(languageServerError
              || languageServerSaveError
              || languageServerCapability?.status === 'error'
              || (languageServerCapability?.status === 'unavailable' && languageServerCapability.detail)) ? (
              <div className="code-plugin-error" role="alert">
                {languageServerSaveError || languageServerError || languageServerCapability?.detail}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className={`code-plugin-toggle ${languageServerEnabled ? 'active' : ''}`}
            aria-pressed={languageServerEnabled}
            disabled={languageServerLoading || languageServerSaving}
            onClick={() => void toggleLanguageServer()}
          >
            {languageServerSaving ? copy.languageServerSaving : languageServerEnabled ? copy.disable : copy.enable}
          </button>
        </article>
      </section> : null}

      {activeTab === 'homes' ? <div
        id="code-plugin-panel-homes"
        className="code-plugin-agent-sections code-plugin-tab-panel"
        data-testid="code-plugin-agent-sections"
        role="tabpanel"
        aria-labelledby="code-plugin-tab-homes"
      >
        <header className="code-plugin-agent-sections-header">
          <div>
            <h3>{copy.agentHomes}</h3>
            <p>{copy.agentHomesDescription}</p>
          </div>
          <button
            type="button"
            className="code-plugin-agent-add"
            disabled={agentSaving || agentGroups.length === 0}
            onClick={() => {
              setAgentGroupsError('')
              setAgentDraft(current => current ? null : {
                provider: agentGroups.find(group => group.available)?.id || agentGroups[0]?.id || 'codex',
                id: '',
                path: '',
              })
            }}
          >
            <PlusGlyph />
            <span>{copy.addAgent}</span>
          </button>
        </header>
        {agentDraft ? (
          <div className="code-plugin-agent-form" data-testid="code-plugin-agent-form">
            <CodeSelect
              className="code-plugin-select"
              label={copy.agentProvider}
              value={agentDraft.provider}
              disabled={agentSaving}
              options={agentGroups.filter(group => group.available).map(group => ({
                value: group.id,
                label: agentDisplayName(group),
              }))}
              onChange={value => setAgentDraft(current => current
                ? { ...current, provider: value }
                : current)}
            />
            <label>
              <span>{copy.homePath}</span>
              <input
                type="text"
                value={agentDraft.path}
                placeholder={copy.homePathPlaceholder}
                disabled={agentSaving}
                onChange={event => setAgentDraft(current => current
                  ? { ...current, path: event.target.value }
                  : current)}
              />
            </label>
            <label>
              <span>{copy.homeName}</span>
              <input
                type="text"
                value={agentDraft.id}
                placeholder={copy.homeNamePlaceholder}
                disabled={agentSaving}
                onChange={event => setAgentDraft(current => current
                  ? { ...current, id: event.target.value }
                  : current)}
              />
            </label>
            <div className="code-plugin-agent-form-actions">
              <button type="button" disabled={agentSaving} onClick={() => setAgentDraft(null)}>
                {copy.cancel}
              </button>
              <button type="button" className="primary" disabled={agentSaving} onClick={submitAgentDraft}>
                {copy.save}
              </button>
            </div>
          </div>
        ) : null}
        {agentGroupsError ? <div className="code-plugin-error" role="alert">{agentGroupsError}</div> : null}
        {agentGroupsLoading && agentGroups.length === 0 ? (
          <p className="code-plugin-empty">{copy.loadingAgentExtensions}</p>
        ) : agentConfigurations.map(configuration => {
          const { provider, home } = configuration
          const key = agentConfigurationKey(provider.id, home.id)
          const isLaunchDefault = provider.launchDefaults.homeId === home.id
          const extensionCount = home.extensions.length
          const configurationSummary = home.configuration.summary.length > 0
            ? home.configuration.summary.map(entry => (
                `${configurationSummaryLabel(entry.key, copy)}: ${entry.value}`
              )).join(' · ')
            : home.configuration.exists
              ? copy.inheritConfiguration(home.configuration.filePath)
              : copy.missingConfiguration(home.configuration.filePath)
          return (
            <section
              key={key}
              className={`code-plugin-section code-plugin-agent-section ${draggingAgentKey === key ? 'dragging' : ''}`}
              data-testid={`code-plugin-section-agent-${provider.id}-${home.id}`}
              onDragOver={event => {
                if (!draggingAgentKey) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
              }}
              onDrop={event => {
                event.preventDefault()
                const sourceKey = event.dataTransfer.getData('text/plain') || draggingAgentKey
                setDraggingAgentKey('')
                reorderAgentConfigurations(sourceKey, key)
              }}
            >
              <header className="code-plugin-section-header code-plugin-agent-header">
                <button
                  type="button"
                  className="code-plugin-agent-drag"
                  draggable={!agentSaving}
                  disabled={agentSaving}
                  aria-label={copy.dragToReorder}
                  title={copy.dragToReorder}
                  onDragStart={event => {
                    setDraggingAgentKey(key)
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', key)
                  }}
                  onDragEnd={() => setDraggingAgentKey('')}
                  onKeyDown={event => {
                    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
                    event.preventDefault()
                    moveAgentConfiguration(key, event.key === 'ArrowUp' ? -1 : 1)
                  }}
                >⋮⋮</button>
                <div className="code-plugin-agent-identity">
                  <h3>
                    {agentDisplayName(provider)}
                    <span>{home.id}</span>
                    {isLaunchDefault ? <span className="code-plugin-agent-launch-default">{copy.launchDefault}</span> : null}
                    {!provider.available ? <em>{copy.unavailableAgent}</em> : null}
                    <small>{copy.count(extensionCount)}</small>
                  </h3>
                  <p><code>{home.path}</code></p>
                </div>
                <div className="code-plugin-agent-actions">
                  {isLaunchDefault && provider.supportsChat ? (
                    <select
                      className="code-plugin-agent-runtime-default"
                      data-testid={`code-plugin-agent-runtime-default-${provider.id}`}
                      aria-label={`${agentDisplayName(provider)} · ${copy.defaultRuntime}`}
                      title={copy.defaultRuntime}
                      value={provider.launchDefaults.runtimeMode}
                      disabled={agentSaving}
                      onChange={event => setLaunchDefaultRuntime(
                        provider.id,
                        event.target.value === 'chat' ? 'chat' : 'terminal',
                      )}
                    >
                      <option value="terminal">Terminal</option>
                      <option value="chat">Chat</option>
                    </select>
                  ) : !isLaunchDefault ? (
                    <button
                      type="button"
                      className="code-plugin-agent-set-default"
                      data-testid={`code-plugin-agent-set-default-${provider.id}-${home.id}`}
                      disabled={agentSaving}
                      onClick={() => setLaunchDefaultHome(provider.id, home.id)}
                    >{copy.setLaunchDefault}</button>
                  ) : null}
                  <button
                    type="button"
                    disabled={agentSaving || !home.configuration.rootId || !home.configuration.filePath}
                    aria-label={copy.edit}
                    title={copy.edit}
                    onClick={() => onOpenAgentHomeConfiguration({
                      ...home.configuration,
                      homePath: home.path,
                    })}
                  ><PencilGlyph /></button>
                  {home.id !== 'default' ? (
                    <button
                      type="button"
                      disabled={agentSaving}
                      aria-label={copy.remove}
                      title={copy.remove}
                      onClick={() => removeAgentConfiguration(provider.id, home.id)}
                    ><CloseGlyph /></button>
                  ) : null}
                </div>
              </header>

              <div className="code-plugin-agent-configuration">
                <strong>{copy.homeConfiguration}</strong>
                <span>{configurationSummary}</span>
              </div>

              {!provider.discoverySupported ? (
                <p className="code-plugin-agent-note">{copy.unsupportedDiscovery}</p>
              ) : null}
            </section>
          )
        })}
      </div> : null}

      {activeTab === 'extensions' ? <section
        id="code-plugin-panel-extensions"
        className="code-plugin-extensions code-plugin-tab-panel"
        data-testid="code-plugin-extensions"
        role="tabpanel"
        aria-labelledby="code-plugin-tab-extensions"
      >
        <header className="code-plugin-extensions-header">
          <div>
            <h3>{copy.agentExtensions}</h3>
            <p>{copy.agentExtensionsDescription}</p>
          </div>
          <div className="code-plugin-extension-tools">
            <label className="code-plugin-extension-search">
              <span>{copy.searchExtensions}</span>
              <input
                type="search"
                value={extensionQuery}
                placeholder={copy.searchExtensions}
                aria-label={copy.searchExtensions}
                onChange={event => setExtensionQuery(event.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={agentGroupsLoading || agentSaving}
              onClick={() => void loadAgentGroups()}
            >
              {copy.refresh}
            </button>
          </div>
        </header>
        {agentGroupsError ? <div className="code-plugin-error" role="alert">{agentGroupsError}</div> : null}
        {agentGroupsLoading && agentGroups.length === 0 ? (
          <p className="code-plugin-empty">{copy.loadingAgentExtensions}</p>
        ) : extensionHomes.length === 0 ? (
          <p className="code-plugin-empty">{copy.noAgentExtensions}</p>
        ) : <>
          <div className="code-plugin-extension-home-tabs" role="tablist" aria-label={copy.agentHomes}>
            {extensionHomes.map(home => (
              <button
                id={`code-plugin-extension-home-${home.domId}`}
                key={home.key}
                type="button"
                role="tab"
                data-testid={`code-plugin-extension-home-${home.domId}`}
                aria-selected={selectedExtensionHome?.key === home.key}
                tabIndex={selectedExtensionHome?.key === home.key ? 0 : -1}
                onClick={() => {
                  updateNavigationState({ activeExtensionHomeKey: home.key, extensionQuery: '' })
                }}
                onKeyDown={handleExtensionHomeKeyDown}
              >
                <span>{home.label}</span>
                <small>{home.extensions.length}</small>
              </button>
            ))}
          </div>
          <div className="code-plugin-extension-kind-tabs" role="tablist" aria-label={copy.agentExtensions}>
            {extensionKinds.map(kind => (
              <button
                id={`code-plugin-extension-kind-${kind.kind}`}
                key={kind.kind}
                type="button"
                role="tab"
                data-testid={`code-plugin-extension-kind-${kind.kind}`}
                aria-selected={selectedExtensionKind === kind.kind}
                disabled={kind.count === 0}
                tabIndex={selectedExtensionKind === kind.kind ? 0 : -1}
                onClick={() => {
                  updateNavigationState({ activeExtensionKind: kind.kind, extensionQuery: '' })
                }}
                onKeyDown={handleExtensionKindKeyDown}
              >
                <span>{extensionKindTabLabel(kind.kind, copy)}</span>
                <small>{kind.count}</small>
              </button>
            ))}
          </div>
          {filteredAgentExtensions.length === 0 ? (
          <p className="code-plugin-empty">
            {extensionQuery.trim() ? copy.noMatchingExtensions : copy.noAgentExtensions}
          </p>
          ) : (
          <section
            className="code-plugin-extension-group"
            data-kind={selectedExtensionKind}
            role="tabpanel"
            aria-labelledby={`code-plugin-extension-kind-${selectedExtensionKind}`}
          >
            <div className="code-plugin-extension-list">
              {filteredAgentExtensions.map(extension => (
                <button
                  type="button"
                  className="code-plugin-extension"
                  key={`${extension.homeKey}:${extension.id}:${extension.sourceFile}`}
                  onClick={event => {
                    selectedExtensionTriggerRef.current = event.currentTarget
                    updateNavigationState({
                      selectedExtension: {
                        homeKey: extension.homeKey,
                        id: extension.id,
                        sourceFile: extension.sourceFile,
                      },
                    })
                  }}
                >
                  <span className="code-plugin-extension-icon" aria-hidden="true"><ExtensionIcon extension={extension} /></span>
                  <span className="code-plugin-extension-copy">
                    <span className="code-plugin-extension-title">
                      <strong>{extension.name}</strong>
                      <span>{extensionKindLabel(extension.kind, copy)}</span>
                    </span>
                    <span className="code-plugin-extension-meta">
                      <code>{extension.sourceFile}</code>
                      {extension.scope ? <span>{extension.scope}</span> : null}
                      <span className={`code-plugin-extension-status ${extension.status}`}>
                        {copy.extensionStatus[extension.status]}
                      </span>
                    </span>
                    <span className="code-plugin-extension-description">{extension.description}</span>
                  </span>
                  <span className="code-plugin-extension-owner">{extension.agentName}</span>
                </button>
              ))}
            </div>
          </section>
          )}
        </>}
      </section> : null}

      {selectedExtension ? (
        <div
          className="code-plugin-detail-backdrop"
          role="presentation"
          onPointerDown={closeSelectedExtension}
        >
          <section
            className="code-plugin-detail-dialog"
            data-testid="code-plugin-detail-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="code-plugin-detail-title"
            onPointerDown={event => event.stopPropagation()}
            onKeyDown={event => {
              if (event.key !== 'Escape') return
              event.stopPropagation()
              closeSelectedExtension()
            }}
          >
            <header>
              <div className="code-plugin-detail-heading">
                <span className="code-plugin-extension-icon" aria-hidden="true"><ExtensionIcon extension={selectedExtension} /></span>
                <div>
                <small>{selectedExtension.agentName} · {copy.extensionDetails}</small>
                <h3 id="code-plugin-detail-title">{selectedExtension.name}</h3>
                </div>
              </div>
              <button
                type="button"
                autoFocus
                aria-label={copy.closeDetails}
                title={copy.closeDetails}
                onClick={closeSelectedExtension}
              >
                <CloseGlyph />
              </button>
            </header>
            <div className="code-plugin-detail-meta">
              <span>{extensionKindLabel(selectedExtension.kind, copy)}</span>
              {selectedExtension.scope ? <span>{selectedExtension.scope}</span> : null}
              <span>{copy.extensionStatus[selectedExtension.status]}</span>
              {selectedExtension.homeId !== 'default' ? <span>{copy.home}: {selectedExtension.homeId}</span> : null}
            </div>
            <p>{selectedExtension.description}</p>
            <div className="code-plugin-detail-source">
              <span>{copy.source}</span>
              <code>{selectedExtension.sourceFile}</code>
            </div>
            <button
              type="button"
              className="code-plugin-detail-open"
              disabled={!selectedExtension.rootId || !selectedExtension.sourceFile}
              onClick={() => onOpenAgentHomeConfiguration({
                exists: true,
                filePath: selectedExtension.sourceFile,
                homePath: selectedExtension.homePath,
                rootId: selectedExtension.rootId,
              })}
            >
              <PencilGlyph />
              <span>{copy.openSource}</span>
            </button>
          </section>
        </div>
      ) : null}
    </div>
  )
}
