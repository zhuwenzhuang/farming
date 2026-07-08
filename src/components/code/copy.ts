import type { UiLanguage } from '@/lib/ui-preferences'

export interface CodeCopy {
  newAgent: string
  search: string
  history: string
  codex: string
  expandSidebar: string
  collapseSidebar: string
  searchProjectsOrAgents: string
  clearSearch: string
  projectsAndAgents: string
  noAgentsYet: string
  noMatchingProjectsOrAgents: string
  openNavigation: string
  closeNavigation: string
  openOptions: string
  agentActions: string
  appearanceLight: string
  appearanceDark: string
  languageEnglish: string
  languageChinese: string
  pinAgent: string
  unpinAgent: string
  renameAgent: string
  renameProject: string
  archiveAgent: string
  markAsRead: string
  markAsUnread: string
  copyWorkingDirectory: string
  copiedWorkingDirectory: string
  copyFailed: string
  sharePage: string
  scanToOpenOnPhone: string
  copyFullShareLink: string
  copiedShareLink: string
  shareLinkFailed: string
  shareLinkExpired: string
  refreshShareLink: string
  forkSameWorktree: string
  forkNewWorktree: string
  newWorktreeFork: string
  scheduledTask: string
  killAgent: string
  killAgentQuestion: string
  openSession: string
  pinChat: string
  unpinChat: string
  archiveChat: string
  archiveChats: string
  archiveProject: string
  deleteWorktree: string
  deleteWorktreeQuestion: string
  deleteWorktreeDirtyDescription: (count: number) => string
  forceDelete: string
  cancel: string
  retry: string
  save: string
  stopAgentDescription: (title: string) => string
  permissionModeLabel: (value: string, fallback: string) => string
  permissionModeDescription: (value: string, fallback: string) => string
  reasoningOptionLabel: (value: string, fallback: string) => string
  serviceTierLabel: (value: string, fallback: string) => string
  serviceTierDescription: (value: string, fallback: string) => string
  messageMode: string
  goalMode: string
  planMode: string
  askFollowUpChanges: string
  describeAgentGoal: string
  describePlanFirst: string
  openAgentTerminalFirst: string
  queuedMessages: (count: number) => string
  steerQueuedMessage: string
  discardQueuedMessage: string
  addContext: string
  attachFile: string
  fileContext: string
  setObjective: string
  planFirst: string
  clearComposerMode: string
  agentPermissionMode: string
  permissionsPrompt: string
  modelAndReasoning: string
  reasoning: string
  speed: string
  startDictation: string
  stopDictation: string
  speechUnsupported: string
  sendMessage: string
  interruptAgent: string
  startOrSelectAgent: string
  startOrSelectAgentDescription: string
  historySummary: (workspaces: number, projects: number, archived: number, sessions: number) => string
  noHistoryYet: string
  noHistoryDescription: string
  historyAgents: string
  agentSessions: string
  recentWorkspaces: string
  agentsSessionsSummary: (agents: number, sessions: number) => string
  restore: string
  continueRun: string
  open: string
  archived: string
  pinned: string
  unread: string
  showMore: string
  showLess: string
  latest: string
  upgrade: string
  updating: string
  retryUpdate: string
  checkForUpdates: string
  updateFailed: string
  upgradeToVersion: (version: string) => string
  sessionFallbackTitle: (providerName?: string) => string
  resumeSessionAria: (title: string) => string
  resultsCount: (count: number) => string
  noMatchingAgents: string
  searchHint: string
  searchEmptyTitle: string
  searchEmptyDescription: string
  agents: string
  files: string
  changes: string
  changedFiles: string
  trackedChanges: string
  untrackedChanges: string
  refreshChanges: string
  searchOrPathLine: string
  searchFilesOrJump: string
  openEditors: string
  loading: string
  searching: string
  noMatches: string
  searchIncomplete: string
  terminalSearchPlaceholder: string
  terminalSearchPrevious: string
  terminalSearchNext: string
  terminalSearchClose: string
  terminalSearchCaseSensitive: string
  terminalSearchWholeWord: string
  terminalSearchRegex: string
  terminalSearchNoResults: string
  terminalSearchResults: (current: number, total: number) => string
  terminalSessionUnavailable: string
  file: string
  folder: string
  go: string
  moreMatchesOmitted: string
  stickyFolderPath: string
  containsUncommittedChanges: string
  changedOnDisk: string
  unsavedChanges: string
  gitStatus: (status: string) => string
  renameEntry: (name: string) => string
  newFile: string
  newFolder: string
  refresh: string
  rename: string
  copyRelativePath: string
  delete: string
  deleteFolderContents: (path?: string) => string
  deleteFile: (path?: string) => string
  saveFile: string
  savingFile: string
  reloadFile: string
  overwriteChangedFile: string
  openFileDiff: string
  openFileDiffFor: (path: string) => string
  closeDiff: string
  openFilePreview: string
  showFileSource: string
  enableWordWrap: string
  disableWordWrap: string
  openMarkdownPreview: string
  showMarkdownSource: string
  openMarkdownSplitPreview: string
  closeMarkdownSplitPreview: string
  markdownPreviewFor: (path: string) => string
  markdownFrontMatter: string
  markdownHeadingAnchor: string
  mermaidDiagram: string
  mermaidDiagramControls: string
  mermaidRendering: string
  mermaidRenderFailed: string
  mermaidZoomIn: string
  mermaidZoomOut: string
  mermaidResetView: string
  mermaidCopySource: string
  mermaidCopiedSource: string
  fileDiff: string
  loadingDiff: string
  noFileDiff: string
  diffUnavailable: string
  binaryDiffUnavailable: string
  diffTooLarge: string
  deletedFileDiffOnly: string
  showGitBlame: string
  hideGitBlame: string
  gitBlameAnnotations: string
  gitBlameDetails: string
  filePath: string
  editorFor: (path: string) => string
  revealInExplorer: (path: string) => string
  previewFor: (path: string) => string
  author: string
  commit: string
  date: string
  line: string
  unknown: string
  uncommitted: string
  closeBlameDetails: string
  cut: string
  copy: string
  paste: string
  selectAll: string
  annotateWithBlame: string
  hideBlame: string
  openLineChangesWithPreviousRevision: string
  openLineChangesWithWorkingFile: string
  lineChanges: string
  loadingLineChanges: string
  noLineChanges: string
  closeLineChanges: string
  close: string
  closeFile: (path: string) => string
  closeOthers: string
  closeToRight: string
  closeSaved: string
  closeAll: string
  saveBeforeCloseTitle: (nameOrCount: string) => string
  saveBeforeCloseDescription: string
  dontSave: string
  loadingBlame: string
  notGitRepository: string
  noCommittedLines: string
  cursorPosition: (line: number, column: number) => string
  startMainAgent: string
  startNewAgent: string
  loadingAgents: string
  agentListUnavailable: string
  noSupportedAgentsFound: string
  resumePreviousMainAgent: string
  codingAgents: string
  otherAgents: string
  workspace: string
  workspacePathPlaceholder: string
  recentWorkspacesLower: string
  start: string
  back: string
  backToAgent: string
  goBack: string
  goForward: string
  backendConnecting: string
  backendConnectionLost: string
  backendHeartbeatLost: string
}

const EN_COPY: CodeCopy = {
  newAgent: 'New Agent',
  search: 'Search',
  history: 'History',
  codex: 'Farming Code',
  expandSidebar: 'Expand sidebar',
  collapseSidebar: 'Collapse sidebar',
  searchProjectsOrAgents: 'Search projects or agents',
  clearSearch: 'Clear search',
  projectsAndAgents: 'Projects and agents',
  noAgentsYet: 'No agents yet.',
  noMatchingProjectsOrAgents: 'No matching projects or agents.',
  openNavigation: 'Open navigation',
  closeNavigation: 'Close navigation',
  openOptions: 'Open options',
  agentActions: 'Agent actions',
  appearanceLight: 'Appearance: Light',
  appearanceDark: 'Appearance: Dark',
  languageEnglish: 'Language: English',
  languageChinese: 'Language: 中文',
  pinAgent: 'Pin Agent',
  unpinAgent: 'Unpin Agent',
  renameAgent: 'Rename Agent',
  renameProject: 'Rename project',
  archiveAgent: 'Archive',
  markAsRead: 'Mark as read',
  markAsUnread: 'Mark as unread',
  copyWorkingDirectory: 'Copy working directory',
  copiedWorkingDirectory: 'Copied working directory',
  copyFailed: 'Copy failed',
  sharePage: 'Share page',
  scanToOpenOnPhone: 'Scan to open on phone',
  copyFullShareLink: 'Copy full link',
  copiedShareLink: 'Copied full link',
  shareLinkFailed: 'Share link unavailable',
  shareLinkExpired: 'Expired',
  refreshShareLink: 'Refresh',
  forkSameWorktree: 'Fork into same worktree',
  forkNewWorktree: 'Fork into new worktree',
  newWorktreeFork: 'Forked to new worktree',
  scheduledTask: 'Scheduled task',
  killAgent: 'Kill Agent',
  killAgentQuestion: 'Kill Agent?',
  openSession: 'Open Session',
  pinChat: 'Pin chat',
  unpinChat: 'Unpin chat',
  archiveChat: 'Archive',
  archiveChats: 'Archive chats',
  archiveProject: 'Archive Project',
  deleteWorktree: 'Delete Worktree',
  deleteWorktreeQuestion: 'Delete Worktree?',
  deleteWorktreeDirtyDescription: count => `${count} uncommitted or untracked file${count === 1 ? '' : 's'} will be deleted with this worktree.`,
  forceDelete: 'Force Delete',
  cancel: 'Cancel',
  retry: 'Retry',
  save: 'Save',
  stopAgentDescription: title => `Stop ${title} and close its terminal.`,
  permissionModeLabel: (_value, fallback) => fallback,
  permissionModeDescription: (_value, fallback) => fallback,
  reasoningOptionLabel: (_value, fallback) => fallback,
  serviceTierLabel: (_value, fallback) => fallback,
  serviceTierDescription: (_value, fallback) => fallback,
  messageMode: 'Message',
  goalMode: 'Goal',
  planMode: 'Plan',
  askFollowUpChanges: 'Ask for follow-up changes',
  describeAgentGoal: 'Describe the goal for this agent',
  describePlanFirst: 'Describe what should be planned first',
  openAgentTerminalFirst: 'Open an agent terminal first',
  queuedMessages: count => `${count} queued messages`,
  steerQueuedMessage: 'Steer',
  discardQueuedMessage: 'Discard queued message',
  addContext: 'Add context',
  attachFile: 'Attach file',
  fileContext: 'File context',
  setObjective: 'Set objective',
  planFirst: 'Plan first',
  clearComposerMode: 'Clear composer mode',
  agentPermissionMode: 'Agent permission mode',
  permissionsPrompt: 'How should this agent handle permissions?',
  modelAndReasoning: 'Model and reasoning',
  reasoning: 'Reasoning',
  speed: 'Speed',
  startDictation: 'Start dictation',
  stopDictation: 'Stop dictation',
  speechUnsupported: 'Speech recognition is not supported in this browser',
  sendMessage: 'Send message',
  interruptAgent: 'Interrupt agent',
  startOrSelectAgent: 'Start or select an agent',
  startOrSelectAgentDescription: 'Projects live on the left. Open any agent terminal without closing the rest of the workspace.',
  historySummary: (_workspaces, _projects, archived, sessions) => `${archived + sessions} history agents`,
  noHistoryYet: 'No history yet',
  noHistoryDescription: 'Agents moved off the main page will appear here.',
  historyAgents: 'History Agents',
  agentSessions: 'Agent Sessions',
  recentWorkspaces: 'Recent Workspaces',
  agentsSessionsSummary: (agents, sessions) => `${agents} agents · ${sessions} sessions`,
  restore: 'Restore',
  continueRun: 'Continue',
  open: 'Open',
  archived: 'Archived',
  pinned: 'Pinned',
  unread: 'Unread',
  showMore: 'Show more',
  showLess: 'Show less',
  latest: 'Latest',
  upgrade: 'UPGRADE',
  updating: 'UPDATING',
  retryUpdate: 'RETRY',
  checkForUpdates: 'Check for updates',
  updateFailed: 'Update failed',
  upgradeToVersion: version => version ? `Upgrade to ${version}` : 'Upgrade Farming Code',
  sessionFallbackTitle: providerName => `${providerName || 'Agent'} session`,
  resumeSessionAria: title => `Resume ${title}`,
  resultsCount: count => `${count} results`,
  noMatchingAgents: 'No matching agents',
  searchHint: 'Search by project, command, task, or workspace.',
  searchEmptyTitle: 'Start a search',
  searchEmptyDescription: 'Type a project, command, task, workspace, or session title.',
  agents: 'Agents',
  files: 'Files',
  changes: 'Changes',
  changedFiles: 'Changed files',
  trackedChanges: 'Tracked',
  untrackedChanges: 'Untracked',
  refreshChanges: 'Refresh changes',
  searchOrPathLine: 'Search or path:line',
  searchFilesOrJump: 'Search files or jump to path line',
  openEditors: 'OPEN EDITORS',
  loading: 'Loading...',
  searching: 'Searching...',
  noMatches: 'No matches',
  searchIncomplete: 'Search stopped early',
  terminalSearchPlaceholder: 'Find in terminal',
  terminalSearchPrevious: 'Previous match',
  terminalSearchNext: 'Next match',
  terminalSearchClose: 'Close terminal search',
  terminalSearchCaseSensitive: 'Match case',
  terminalSearchWholeWord: 'Match whole word',
  terminalSearchRegex: 'Use regular expression',
  terminalSearchNoResults: 'No results',
  terminalSearchResults: (current, total) => `${current}/${total}`,
  terminalSessionUnavailable: 'Terminal session unavailable',
  file: 'File',
  folder: 'Folder',
  go: 'Go',
  moreMatchesOmitted: 'More matches omitted',
  stickyFolderPath: 'Sticky folder path',
  containsUncommittedChanges: 'Contains uncommitted changes',
  changedOnDisk: 'Changed on disk',
  unsavedChanges: 'Unsaved changes',
  gitStatus: status => `Git status: ${status}`,
  renameEntry: name => `Rename ${name}`,
  newFile: 'New File',
  newFolder: 'New Folder',
  refresh: 'Refresh',
  rename: 'Rename',
  copyRelativePath: 'Copy Relative Path',
  delete: 'Delete',
  deleteFolderContents: path => `Delete folder and all contents: ${path || ''}`,
  deleteFile: path => `Delete file: ${path || ''}`,
  saveFile: 'Save file',
  savingFile: 'Saving file',
  reloadFile: 'Reload file',
  overwriteChangedFile: 'Overwrite changed file',
  openFileDiff: 'Open File Diff',
  openFileDiffFor: path => `Open diff for ${path}`,
  closeDiff: 'Close diff',
  openFilePreview: 'Open preview',
  showFileSource: 'Show source',
  enableWordWrap: 'Enable word wrap',
  disableWordWrap: 'Disable word wrap',
  openMarkdownPreview: 'Open Markdown preview',
  showMarkdownSource: 'Show Markdown source',
  openMarkdownSplitPreview: 'Open Markdown preview to side',
  closeMarkdownSplitPreview: 'Close Markdown side preview',
  markdownPreviewFor: path => `Markdown preview for ${path}`,
  markdownFrontMatter: 'Front matter',
  markdownHeadingAnchor: 'Link to heading',
  mermaidDiagram: 'Mermaid diagram',
  mermaidDiagramControls: 'Mermaid diagram controls',
  mermaidRendering: 'Rendering diagram...',
  mermaidRenderFailed: 'Unable to render Mermaid diagram',
  mermaidZoomIn: 'Zoom in',
  mermaidZoomOut: 'Zoom out',
  mermaidResetView: 'Reset view',
  mermaidCopySource: 'Copy Mermaid source',
  mermaidCopiedSource: 'Copied Mermaid source',
  fileDiff: 'File Diff',
  loadingDiff: 'Loading diff...',
  noFileDiff: 'No file changes.',
  diffUnavailable: 'Diff content is unavailable for this file.',
  binaryDiffUnavailable: 'Binary file diff is unavailable.',
  diffTooLarge: 'Diff is too large to display.',
  deletedFileDiffOnly: 'This deleted file is only available as a diff.',
  showGitBlame: 'Show git blame',
  hideGitBlame: 'Hide git blame',
  gitBlameAnnotations: 'Git blame annotations',
  gitBlameDetails: 'Git blame details',
  filePath: 'File path',
  editorFor: path => `Editor for ${path}`,
  revealInExplorer: path => `Reveal ${path} in Explorer`,
  previewFor: path => `Preview for ${path}`,
  author: 'Author',
  commit: 'Commit',
  date: 'Date',
  line: 'Line',
  unknown: 'Unknown',
  uncommitted: 'Uncommitted',
  closeBlameDetails: 'Close blame details',
  cut: 'Cut',
  copy: 'Copy',
  paste: 'Paste',
  selectAll: 'Select All',
  annotateWithBlame: 'Annotate with Blame',
  hideBlame: 'Hide Blame',
  openLineChangesWithPreviousRevision: 'Open Line Changes with Previous Revision',
  openLineChangesWithWorkingFile: 'Open Line Changes with Working File',
  lineChanges: 'Line changes',
  loadingLineChanges: 'Loading line changes...',
  noLineChanges: 'No line changes for this line.',
  closeLineChanges: 'Close line changes',
  close: 'Close',
  closeFile: path => `Close ${path}`,
  closeOthers: 'Close Others',
  closeToRight: 'Close to the Right',
  closeSaved: 'Close Saved',
  closeAll: 'Close All',
  saveBeforeCloseTitle: nameOrCount => `Save changes to ${nameOrCount}?`,
  saveBeforeCloseDescription: 'If you do not save, your changes will be lost.',
  dontSave: "Don't Save",
  loadingBlame: 'Loading blame...',
  notGitRepository: 'Not a git repository.',
  noCommittedLines: 'No committed lines.',
  cursorPosition: (line, column) => `Ln ${line}, Col ${column}`,
  startMainAgent: 'Start Main Agent',
  startNewAgent: 'Start New Agent',
  loadingAgents: 'Loading agents...',
  agentListUnavailable: 'Agent list unavailable.',
  noSupportedAgentsFound: 'No supported agents found.',
  resumePreviousMainAgent: 'Resume previous Main Agent',
  codingAgents: 'coding agents',
  otherAgents: 'others',
  workspace: 'Workspace:',
  workspacePathPlaceholder: '/path/to/workspace',
  recentWorkspacesLower: 'recent workspaces',
  start: 'Start',
  back: 'Back',
  backToAgent: 'Back to Agent',
  goBack: 'Go Back',
  goForward: 'Go Forward',
  backendConnecting: 'Connecting to Farming backend...',
  backendConnectionLost: 'Farming backend disconnected. Reconnecting...',
  backendHeartbeatLost: 'No Farming backend heartbeat. Waiting for it to recover...',
}

const ZH_COPY: CodeCopy = {
  newAgent: '新建 Agent',
  search: '搜索',
  history: '历史',
  codex: 'Farming Code',
  expandSidebar: '展开侧边栏',
  collapseSidebar: '收起侧边栏',
  searchProjectsOrAgents: '搜索项目或 Agent',
  clearSearch: '清空搜索',
  projectsAndAgents: '项目与 Agent',
  noAgentsYet: '还没有 Agent。',
  noMatchingProjectsOrAgents: '没有匹配的项目或 Agent。',
  openNavigation: '打开导航',
  closeNavigation: '关闭导航',
  openOptions: '打开选项',
  agentActions: 'Agent 操作',
  appearanceLight: '外观：浅色',
  appearanceDark: '外观：深色',
  languageEnglish: '语言：English',
  languageChinese: '语言：中文',
  pinAgent: '置顶 Agent',
  unpinAgent: '取消置顶',
  renameAgent: '重命名 Agent',
  renameProject: '重命名项目',
  archiveAgent: '归档',
  markAsRead: '标为已读',
  markAsUnread: '标为未读',
  copyWorkingDirectory: '复制工作目录',
  copiedWorkingDirectory: '已复制工作目录',
  copyFailed: '复制失败',
  sharePage: '分享页面',
  scanToOpenOnPhone: '手机扫码打开',
  copyFullShareLink: '复制完整链接',
  copiedShareLink: '已复制完整链接',
  shareLinkFailed: '分享链接不可用',
  shareLinkExpired: '已过期',
  refreshShareLink: '刷新',
  forkSameWorktree: '在同一 worktree 分叉',
  forkNewWorktree: '分叉到新 worktree',
  newWorktreeFork: '已分叉到新 worktree',
  scheduledTask: '周期任务',
  killAgent: '停止 Agent',
  killAgentQuestion: '停止 Agent？',
  openSession: '打开会话',
  pinChat: '置顶会话',
  unpinChat: '取消置顶会话',
  archiveChat: '归档',
  archiveChats: '归档会话',
  archiveProject: '归档项目',
  deleteWorktree: '删除 worktree',
  deleteWorktreeQuestion: '删除 worktree？',
  deleteWorktreeDirtyDescription: count => `这个 worktree 里还有 ${count} 个未提交或未跟踪文件，强删会连同目录一起删除。`,
  forceDelete: '强制删除',
  cancel: '取消',
  retry: '重试',
  save: '保存',
  stopAgentDescription: title => `停止 ${title} 并关闭它的终端。`,
  permissionModeLabel: (value, fallback) => ({
    ask: '请求批准',
    approve: '自动批准',
    full: '完全访问',
    custom: '自定义',
    default: '默认',
    auto: '自动',
    acceptEdits: '接受编辑',
    dontAsk: '不询问',
    plan: '计划',
    bypassPermissions: '绕过权限',
  }[value] ?? fallback),
  permissionModeDescription: (value, fallback) => ({
    ask: '编辑外部文件或访问网络时始终询问',
    approve: '仅在检测到潜在风险操作时询问',
    full: '允许访问网络和这台电脑上的任意文件',
    custom: '使用 config.toml 中定义的权限',
    default: '使用 Claude Code 设置',
    auto: '让 Claude 判断何时询问',
    acceptEdits: '允许文件编辑，其他高风险操作仍会询问',
    dontAsk: '在 Claude 支持时尽量避免交互式批准',
    plan: '以计划权限模式启动 Claude Code',
    bypassPermissions: '仅在可信沙箱中绕过权限检查',
  }[value] ?? fallback),
  reasoningOptionLabel: (value, fallback) => ({
    config: '使用配置',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '超高',
    max: '最高',
  }[value] ?? fallback),
  serviceTierLabel: (value, fallback) => ({
    default: '标准',
    priority: '快',
    flex: '弹性',
  }[value] ?? fallback),
  serviceTierDescription: (value, fallback) => ({
    default: '默认速度',
    priority: '1.5 倍速度，用量增加',
  }[value] ?? fallback),
  messageMode: '消息',
  goalMode: '目标',
  planMode: '计划',
  askFollowUpChanges: '输入后续修改要求',
  describeAgentGoal: '描述这个 Agent 的目标',
  describePlanFirst: '描述需要先规划的事情',
  openAgentTerminalFirst: '先打开一个 Agent 终端',
  queuedMessages: count => `${count} 条排队消息`,
  steerQueuedMessage: '引导',
  discardQueuedMessage: '丢弃排队消息',
  addContext: '添加上下文',
  attachFile: '附加文件',
  fileContext: '文件上下文',
  setObjective: '设置目标',
  planFirst: '先做计划',
  clearComposerMode: '清除输入模式',
  agentPermissionMode: 'Agent 权限模式',
  permissionsPrompt: '这个 Agent 应该如何处理权限？',
  modelAndReasoning: '模型与推理',
  reasoning: '推理',
  speed: '速度',
  startDictation: '开始语音输入',
  stopDictation: '停止语音输入',
  speechUnsupported: '当前浏览器不支持语音识别',
  sendMessage: '发送消息',
  interruptAgent: '中止 Agent',
  startOrSelectAgent: '启动或选择一个 Agent',
  startOrSelectAgentDescription: '项目在左侧。打开任意 Agent 终端时，不会关闭其他工作区。',
  historySummary: (_workspaces, _projects, archived, sessions) => `${archived + sessions} 个 History Agents`,
  noHistoryYet: '还没有历史记录',
  noHistoryDescription: '从主页面移出的 Agent 会出现在这里。',
  historyAgents: 'History Agents',
  agentSessions: 'Agent 会话',
  recentWorkspaces: '最近工作区',
  agentsSessionsSummary: (agents, sessions) => `${agents} 个 Agent · ${sessions} 个会话`,
  restore: '恢复',
  continueRun: '继续',
  open: '打开',
  archived: '已归档',
  pinned: '已置顶',
  unread: '未读',
  showMore: '显示更多',
  showLess: '收起',
  latest: '最新',
  upgrade: '升级',
  updating: '更新中',
  retryUpdate: '重试',
  checkForUpdates: '检查更新',
  updateFailed: '更新失败',
  upgradeToVersion: version => version ? `升级到 ${version}` : '升级 Farming Code',
  sessionFallbackTitle: providerName => `${providerName || 'Agent'} 会话`,
  resumeSessionAria: title => `恢复 ${title}`,
  resultsCount: count => `${count} 个结果`,
  noMatchingAgents: '没有匹配的 Agent',
  searchHint: '可按项目、命令、任务或工作区搜索。',
  searchEmptyTitle: '开始搜索',
  searchEmptyDescription: '输入项目、命令、任务、工作区或会话标题。',
  agents: 'Agent',
  files: '文件',
  changes: '变更',
  changedFiles: '变更文件',
  trackedChanges: '已跟踪',
  untrackedChanges: '未跟踪',
  refreshChanges: '刷新变更',
  searchOrPathLine: '搜索或路径:行号',
  searchFilesOrJump: '搜索文件或跳转到路径行号',
  openEditors: '打开的编辑器',
  loading: '加载中...',
  searching: '搜索中...',
  noMatches: '无匹配',
  searchIncomplete: '搜索提前停止',
  terminalSearchPlaceholder: '在终端中查找',
  terminalSearchPrevious: '上一个匹配',
  terminalSearchNext: '下一个匹配',
  terminalSearchClose: '关闭终端搜索',
  terminalSearchCaseSensitive: '区分大小写',
  terminalSearchWholeWord: '全词匹配',
  terminalSearchRegex: '使用正则表达式',
  terminalSearchNoResults: '无结果',
  terminalSearchResults: (current, total) => `${current}/${total}`,
  terminalSessionUnavailable: '终端会话不可用',
  file: '文件',
  folder: '文件夹',
  go: '跳转',
  moreMatchesOmitted: '更多匹配已省略',
  stickyFolderPath: '固定文件夹路径',
  containsUncommittedChanges: '包含未提交改动',
  changedOnDisk: '磁盘上已变更',
  unsavedChanges: '未保存改动',
  gitStatus: status => `Git 状态：${status}`,
  renameEntry: name => `重命名 ${name}`,
  newFile: '新建文件',
  newFolder: '新建文件夹',
  refresh: '刷新',
  rename: '重命名',
  copyRelativePath: '复制相对路径',
  delete: '删除',
  deleteFolderContents: path => `删除文件夹及其所有内容：${path || ''}`,
  deleteFile: path => `删除文件：${path || ''}`,
  saveFile: '保存文件',
  savingFile: '正在保存文件',
  reloadFile: '重新加载文件',
  overwriteChangedFile: '覆盖已变更文件',
  openFileDiff: '打开文件 Diff',
  openFileDiffFor: path => `打开 ${path} 的 Diff`,
  closeDiff: '关闭 Diff',
  openFilePreview: '打开预览',
  showFileSource: '显示源码',
  enableWordWrap: '开启折行',
  disableWordWrap: '关闭折行',
  openMarkdownPreview: '打开 Markdown 预览',
  showMarkdownSource: '显示 Markdown 源码',
  openMarkdownSplitPreview: '打开 Markdown 侧边预览',
  closeMarkdownSplitPreview: '关闭 Markdown 侧边预览',
  markdownPreviewFor: path => `${path} 的 Markdown 预览`,
  markdownFrontMatter: 'Front matter',
  markdownHeadingAnchor: '跳转到这个标题',
  mermaidDiagram: 'Mermaid 图表',
  mermaidDiagramControls: 'Mermaid 图表控制',
  mermaidRendering: '正在渲染图表...',
  mermaidRenderFailed: '无法渲染 Mermaid 图表',
  mermaidZoomIn: '放大',
  mermaidZoomOut: '缩小',
  mermaidResetView: '重置视图',
  mermaidCopySource: '复制 Mermaid 源码',
  mermaidCopiedSource: '已复制 Mermaid 源码',
  fileDiff: '文件 Diff',
  loadingDiff: '正在加载 Diff...',
  noFileDiff: '文件没有变化。',
  diffUnavailable: '这个文件没有可显示的 Diff 内容。',
  binaryDiffUnavailable: '二进制文件不能显示 Diff。',
  diffTooLarge: 'Diff 过大，无法显示。',
  deletedFileDiffOnly: '这个已删除文件只支持以 Diff 查看。',
  showGitBlame: '显示 Git Blame',
  hideGitBlame: '隐藏 Git Blame',
  gitBlameAnnotations: 'Git Blame 标注',
  gitBlameDetails: 'Git Blame 详情',
  filePath: '文件路径',
  editorFor: path => `${path} 的编辑器`,
  revealInExplorer: path => `在文件树中显示 ${path}`,
  previewFor: path => `${path} 的预览`,
  author: '作者',
  commit: '提交',
  date: '日期',
  line: '行',
  unknown: '未知',
  uncommitted: '未提交',
  closeBlameDetails: '关闭 Blame 详情',
  cut: '剪切',
  copy: '复制',
  paste: '粘贴',
  selectAll: '全选',
  annotateWithBlame: '用 Blame 标注',
  hideBlame: '隐藏 Blame',
  openLineChangesWithPreviousRevision: '打开与上一版的行变化',
  openLineChangesWithWorkingFile: '打开与工作区文件的行变化',
  lineChanges: '行变化',
  loadingLineChanges: '正在加载行变化...',
  noLineChanges: '这一行没有可显示的变化。',
  closeLineChanges: '关闭行变化',
  close: '关闭',
  closeFile: path => `关闭 ${path}`,
  closeOthers: '关闭其他',
  closeToRight: '关闭右侧',
  closeSaved: '关闭已保存',
  closeAll: '全部关闭',
  saveBeforeCloseTitle: nameOrCount => `是否保存对 ${nameOrCount} 的更改？`,
  saveBeforeCloseDescription: '如果不保存，你的更改将丢失。',
  dontSave: '不保存',
  loadingBlame: '正在加载 Blame...',
  notGitRepository: '不是 Git 仓库。',
  noCommittedLines: '没有已提交行。',
  cursorPosition: (line, column) => `第 ${line} 行，第 ${column} 列`,
  startMainAgent: '启动 Main Agent',
  startNewAgent: '启动新 Agent',
  loadingAgents: '正在加载 Agent...',
  agentListUnavailable: 'Agent 列表不可用。',
  noSupportedAgentsFound: '没有找到支持的 Agent。',
  resumePreviousMainAgent: '恢复上一个 Main Agent',
  codingAgents: '代码 Agent',
  otherAgents: '其他',
  workspace: '工作区：',
  workspacePathPlaceholder: '/工作区/路径',
  recentWorkspacesLower: '最近工作区',
  start: '启动',
  back: '返回',
  backToAgent: '返回 Agent',
  goBack: '后退',
  goForward: '前进',
  backendConnecting: '正在连接 Farming 后端...',
  backendConnectionLost: 'Farming 后端连接已断开，正在重连...',
  backendHeartbeatLost: '没有收到 Farming 后端心跳，正在等待恢复...',
}

export function codeCopyForLanguage(language: UiLanguage): CodeCopy {
  return language === 'zh' ? ZH_COPY : EN_COPY
}
