import type { UiLanguage } from '@/lib/ui-preferences'

export interface CodeCopy {
  newAgent: string
  search: string
  history: string
  codex: string
  expandSidebar: string
  collapseSidebar: string
  enterFocusMode: string
  exitFocusMode: string
  appModeOpen: string
  appModeTitle: string
  appModeDescription: string
  appModeRecommended: string
  appModeInstallTitle: string
  appModeInstallDescription: string
  appModeInstallAction: string
  appModeInstallStepOne: string
  appModeInstallStepTwo: string
  appModeInstallUnavailableTitle: string
  appModeInstallUnavailableInsecure: string
  appModeInstallUnavailableBrowser: string
  appModeFullscreenTitle: string
  appModeFullscreenDescription: string
  terminalView: string
  transcriptView: string
  switchToTerminal: string
  switchToChat: string
  collapseComposer: string
  restoreComposer: string
  codexTranscriptSyncing: string
  codexTranscriptUnavailable: string
  codexTranscriptEmpty: string
  codexTranscriptWaiting: string
  codexTranscriptProcess: string
  codexTranscriptWorking: string
  codexTranscriptThinking: string
  codexTranscriptRunning: string
  codexTranscriptReading: string
  codexTranscriptSearching: string
  codexTranscriptEditing: string
  codexTranscriptPlanActive: string
  codexTranscriptPlanProgress: (completed: number, total: number) => string
  codexTranscriptFetching: string
  codexTranscriptUsingTool: string
  codexTranscriptWorkedFor: (duration: string) => string
  codexTranscriptProcessCount: (count: number) => string
  codexTranscriptCopyDetails: string
  codexTranscriptCopiedDetails: string
  codexTranscriptCopyAnswer: string
  codexTranscriptCopiedAnswer: string
  codexTranscriptReviewChanges: string
  codexTranscriptShowChanges: string
  codexTranscriptLoadingChanges: string
  codexTranscriptKeepChange: string
  codexTranscriptRevertChange: string
  codexTranscriptChangeKept: string
  codexTranscriptChangeReverted: string
  codexTranscriptShowMoreFiles: (count: number) => string
  codexGoalTitle: string
  codexGoalEmpty: string
  codexGoalOpen: string
  codexGoalObjective: string
  codexGoalStatus: string
  codexGoalTokenBudget: string
  codexGoalNoBudget: string
  codexGoalUsage: (tokens: number, seconds: number) => string
  codexGoalStatusLabel: (status: string) => string
  codexGoalEdit: string
  codexGoalStart: string
  codexGoalStop: string
  codexGoalDelete: string
  codexGoalSave: string
  codexGoalClear: string
  codexGoalSaving: string
  searchProjectsOrAgents: string
  clearSearch: string
  projectsAndAgents: string
  noAgentsYet: string
  noMatchingProjectsOrAgents: string
  openNavigation: string
  closeNavigation: string
  resizeNavigation: string
  openOptions: string
  openSettings: string
  agentActions: string
  appearanceLight: string
  appearanceDark: string
  languageEnglish: string
  languageChinese: string
  pinAgent: string
  unpinAgent: string
  pinProject: string
  unpinProject: string
  revealInFinder: string
  revealInFinderFailed: string
  createPermanentWorktree: string
  permanentWorktreeCreated: string
  permanentWorktreeFailed: string
  markAllAsRead: string
  renameAgent: string
  renameProject: string
  archiveAgent: string
  reorderAgentFailed: string
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
  sharedLocationUnavailable: (path: string) => string
  shareLinkExpired: string
  refreshShareLink: string
  brandStoryOrigin: string
  brandStoryPurpose: string
  brandGithub: string
  renameInstance: string
  instanceNameTitle: string
  instanceNameDescription: string
  instanceNamePlaceholder: string
  instanceNameSaveFailed: string
  mobileShareTitle: string
  mobileForwardTitle: string
  mobileForwardHint: string
  mobileShareCopyAction: string
  mobileShareCopied: string
  mobileInstallTitle: string
  mobileInstallChromeHint: string
  mobileInstallShareStep: string
  mobileInstallMoreStep: string
  mobileInstallAddStep: string
  mobileInstallOpenStep: string
  mobileShareInstalled: string
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
  removeProject: string
  deleteWorktree: string
  deleteWorktreeQuestion: string
  deleteWorktreeDescription: string
  forceDelete: string
  cancel: string
  retry: string
  save: string
  stopAgentDescription: (title: string) => string
  permissionModeLabel: (value: string, fallback: string) => string
  permissionModeDescription: (value: string, fallback: string) => string
  acpModeLabel: (value: string, fallback: string) => string
  acpModeDescription: (value: string, fallback: string) => string
  reasoningOptionLabel: (value: string, fallback: string) => string
  serviceTierLabel: (value: string, fallback: string) => string
  serviceTierDescription: (value: string, fallback: string) => string
  messageMode: string
  goalMode: string
  planMode: string
  askFollowUpChanges: string
  shellCommandPlaceholder: string
  describeAgentGoal: string
  describePlanFirst: string
  openAgentTerminalFirst: string
  queuedMessages: (count: number) => string
  sendQueuedMessage: string
  discardQueuedMessage: string
  addContext: string
  attachFile: string
  fileContext: string
  acpSignOut: string
  acpSigningOut: string
  acpSignOutDescription: string
  setObjective: string
  planFirst: string
  clearComposerMode: string
  agentPermissionMode: string
  permissionsPrompt: string
  permissionProfileSavedForNextLaunch: string
  permissionProfileRestarting: string
  runtimeModeRestarting: string
  terminalProfileApplying: string
  terminalProfileApplied: string
  terminalProfileFailed: (message: string) => string
  agentRestartTimedOut: string
  permissionRestartHint: string
  modelAndReasoning: string
  reasoning: string
  speed: string
  startDictation: string
  stopDictation: string
  speechUnsupported: string
  mobileDictationHint: string
  sendMessage: string
  interruptAgent: string
  startOrSelectAgent: string
  startOrSelectAgentDescription: string
  historySummary: (workspaces: number, projects: number, archived: number, sessions: number) => string
  searchHistory: string
  noHistoryYet: string
  noHistoryDescription: string
  historyAgents: string
  historyPagination: string
  historyPageStatus: (page: number, totalPages: number, totalItems: number, hasMore: boolean) => string
  previousPage: string
  nextPage: string
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
  showAgents: string
  hideAgents: string
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
  reviewChanges: string
  refreshChanges: string
  worktrees: string
  showWorktrees: string
  worktreeCurrent: string
  worktreeMain: string
  worktreeDetached: string
  worktreeLocked: string
  worktreePrunable: string
  worktreeLoadFailed: string
  gitHistory: string
  gitHistoryEmpty: string
  gitHistoryNotRepository: string
  gitHistoryLoadMore: string
  gitHistoryView: string
  gitHistoryCurrentScope: string
  gitHistoryAllScope: string
  gitHistoryCurrentBranch: string
  gitHistoryAllBranches: string
  gitHistoryCommitMessage: string
  gitHistoryParent: string
  gitHistoryRootCommit: string
  gitHistoryReviewCommit: string
  gitHistoryCommitChanges: (count: number) => string
  gitHistoryNoChanges: string
  gitHistoryChangesTruncated: string
  searchOrPathLine: string
  searchFilesOrJump: string
  openEditors: string
  loading: string
  searching: string
  noMatches: string
  searchIgnoredFolders: string
  searchIncomplete: (timeoutMs: number) => string
  terminalSearchPlaceholder: string
  terminalSearchPrevious: string
  terminalSearchNext: string
  terminalSearchClose: string
  terminalSearchCaseSensitive: string
  terminalSearchWholeWord: string
  terminalSearchRegex: string
  terminalSearchNoResults: string
  terminalSearchResults: (current: number, total: number) => string
  terminalRecoveryRequesting: string
  terminalRecoveryInstalling: string
  terminalRecoveryRetrying: (delaySeconds: number) => string
  terminalRecoveryElapsed: (seconds: number) => string
  terminalRecoveryAttempt: (attempt: number) => string
  terminalSessionUnavailable: string
  acpPermissionAllow: string
  acpPermissionTitle: string
  acpPermissionTool: string
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
  refreshFiles: string
  refreshingFiles: string
  filesRefreshed: string
  filesRefreshFailed: string
  refresh: string
  rename: string
  copyRelativePath: string
  copyShareUrl: string
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
  mermaidPanMode: string
  mermaidEnterFullscreen: string
  mermaidExitFullscreen: string
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
  chooseWorkspaceDirectory: string
  workspaceDirectoryBrowserFailed: string
  workspaceDirectoryBrowserHostHint: string
  workspaceDirectoryBrowserGo: string
  workspaceDirectoryBrowserParent: string
  workspaceDirectoryBrowserEmpty: string
  workspaceDirectoryBrowserTruncated: string
  workspaceDirectoryBrowserSelect: string
  workspaceMissingTitle: string
  workspaceMissingDescription: string
  workspaceCreateAndStart: string
  workspaceCreating: string
  workspaceCreateFailedTitle: string
  workspaceCreateForbiddenDescription: string
  workspaceCreateFailedDescription: string
  returnToWorkspace: string
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
  enterFocusMode: 'Enter focus mode',
  exitFocusMode: 'Exit focus mode',
  appModeOpen: 'App mode and fullscreen',
  appModeTitle: 'Use Farming without browser controls',
  appModeDescription: 'Use a clean app window where the browser supports it, or fullscreen temporarily.',
  appModeRecommended: 'Recommended',
  appModeInstallTitle: 'Install Farming 2',
  appModeInstallDescription: 'Opens as its own window without tabs, the address bar, or browser extensions.',
  appModeInstallAction: 'Install Farming 2',
  appModeInstallStepOne: 'Open Chrome’s ⋮ menu, then choose “Cast, save and share”.',
  appModeInstallStepTwo: 'Choose “Install page as app”, then open Farming 2 from its app icon.',
  appModeInstallUnavailableTitle: 'Browser app installation is unavailable',
  appModeInstallUnavailableInsecure: 'This deployment uses an insecure HTTP connection, so the browser cannot install it as an app.',
  appModeInstallUnavailableBrowser: 'This browser has not provided an app-install prompt for this deployment.',
  appModeFullscreenTitle: 'Fullscreen for now',
  appModeFullscreenDescription: 'Hide browser controls for this window. Press Esc to leave fullscreen.',
  terminalView: 'Terminal',
  transcriptView: 'Chat',
  switchToTerminal: 'Switch to Terminal',
  switchToChat: 'Switch to Chat',
  collapseComposer: 'Hide input',
  restoreComposer: 'Show input',
  codexTranscriptSyncing: 'Syncing chat history...',
  codexTranscriptUnavailable: 'This session’s Chat history could not be loaded.',
  codexTranscriptEmpty: '',
  codexTranscriptWaiting: 'Agent is still working...',
  codexTranscriptProcess: 'Worked',
  codexTranscriptWorking: 'Processing',
  codexTranscriptThinking: 'Thinking',
  codexTranscriptRunning: 'Running',
  codexTranscriptReading: 'Reading',
  codexTranscriptSearching: 'Searching',
  codexTranscriptEditing: 'Editing',
  codexTranscriptPlanActive: 'On plan',
  codexTranscriptPlanProgress: (completed, total) => `Plan ${completed}/${total}`,
  codexTranscriptFetching: 'Fetching',
  codexTranscriptUsingTool: 'Using tool',
  codexTranscriptWorkedFor: duration => `Worked for ${duration}`,
  codexTranscriptProcessCount: count => `${count} ${count === 1 ? 'event' : 'events'}`,
  codexTranscriptCopyDetails: 'Copy details',
  codexTranscriptCopiedDetails: 'Copied',
  codexTranscriptCopyAnswer: 'Copy answer',
  codexTranscriptCopiedAnswer: 'Copied answer',
  codexTranscriptReviewChanges: 'Review',
  codexTranscriptShowChanges: 'Show file changes',
  codexTranscriptLoadingChanges: 'Loading exact changes…',
  codexTranscriptKeepChange: 'Keep',
  codexTranscriptRevertChange: 'Revert',
  codexTranscriptChangeKept: 'Kept',
  codexTranscriptChangeReverted: 'Reverted',
  codexTranscriptShowMoreFiles: count => `Show ${count} more file${count === 1 ? '' : 's'}`,
  codexGoalTitle: 'Goal',
  codexGoalEmpty: 'No active goal',
  codexGoalOpen: 'Open goal controls',
  codexGoalObjective: 'Objective',
  codexGoalStatus: 'Status',
  codexGoalTokenBudget: 'Token budget',
  codexGoalNoBudget: 'No budget',
  codexGoalUsage: (tokens, seconds) => `${tokens.toLocaleString()} tokens · ${Math.round(seconds / 60)}m`,
  codexGoalStatusLabel: status => ({
    active: 'Active',
    paused: 'Paused',
    blocked: 'Blocked',
    usageLimited: 'Usage limited',
    budgetLimited: 'Budget limited',
    complete: 'Complete',
  }[status] ?? status),
  codexGoalEdit: 'Edit',
  codexGoalStart: 'Start',
  codexGoalStop: 'Stop',
  codexGoalDelete: 'Delete',
  codexGoalSave: 'Save goal',
  codexGoalClear: 'Clear',
  codexGoalSaving: 'Saving...',
  searchProjectsOrAgents: 'Search projects or agents',
  clearSearch: 'Clear search',
  projectsAndAgents: 'Projects and agents',
  noAgentsYet: 'No agents yet.',
  noMatchingProjectsOrAgents: 'No matching projects or agents.',
  openNavigation: 'Open navigation',
  closeNavigation: 'Close navigation',
  resizeNavigation: 'Resize navigation',
  openOptions: 'Open options',
  openSettings: 'Settings',
  agentActions: 'Agent actions',
  appearanceLight: 'Appearance: Light',
  appearanceDark: 'Appearance: Dark',
  languageEnglish: 'Language: English',
  languageChinese: 'Language: 中文',
  pinAgent: 'Pin Agent',
  unpinAgent: 'Unpin Agent',
  pinProject: 'Pin project',
  unpinProject: 'Unpin project',
  revealInFinder: 'Reveal in Finder',
  revealInFinderFailed: 'Failed to reveal project in Finder',
  createPermanentWorktree: 'Create permanent worktree',
  permanentWorktreeCreated: 'Permanent worktree created',
  permanentWorktreeFailed: 'Failed to create permanent worktree',
  markAllAsRead: 'Mark all as read',
  renameAgent: 'Rename Agent',
  renameProject: 'Rename project',
  archiveAgent: 'Archive',
  reorderAgentFailed: 'Failed to reorder Agent',
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
  sharedLocationUnavailable: path => `Unable to locate shared path: ${path}`,
  shareLinkExpired: 'Expired',
  refreshShareLink: 'Refresh',
  brandStoryOrigin: 'Farming Code began with a simple idea: when several coding agents work at once, people should not have to bounce between terminals, editors, and browser tabs.',
  brandStoryPurpose: 'It brings conversations, terminals, project files, and progress into one calm workspace, so attention stays on what matters.',
  brandGithub: 'GitHub',
  renameInstance: 'Rename instance',
  instanceNameTitle: 'Rename Farming instance',
  instanceNameDescription: 'This name appears in the sidebar and browser tab for this Farming machine.',
  instanceNamePlaceholder: 'Machine name',
  instanceNameSaveFailed: 'Could not save the instance name.',
  mobileShareTitle: 'Share page',
  mobileForwardTitle: 'Send this page',
  mobileForwardHint: 'Copy the link to send the current view to someone else.',
  mobileShareCopyAction: 'Copy link',
  mobileShareCopied: 'Copied',
  mobileInstallTitle: 'Add to Home Screen',
  mobileInstallChromeHint: 'Make sure this page is open in your system browser or Chrome.',
  mobileInstallShareStep: 'Tap Share in the browser toolbar.',
  mobileInstallMoreStep: 'If it is hidden, tap •••, then Share.',
  mobileInstallAddStep: 'Choose “Add to Home Screen”.',
  mobileInstallOpenStep: 'Open Farming from its Home Screen icon next time.',
  mobileShareInstalled: 'Farming is already open as a Home Screen app.',
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
  removeProject: 'Remove Project',
  deleteWorktree: 'Permanently Delete Worktree',
  deleteWorktreeQuestion: 'Permanently delete worktree?',
  deleteWorktreeDescription: 'This permanently deletes the worktree and all of its files.',
  forceDelete: 'Permanently Delete',
  cancel: 'Cancel',
  retry: 'Retry',
  save: 'Save',
  stopAgentDescription: title => `Stop ${title} and close its terminal.`,
  permissionModeLabel: (_value, fallback) => fallback,
  permissionModeDescription: (_value, fallback) => fallback,
  acpModeLabel: (value, fallback) => ({
    'read-only': 'Read-only',
    agent: 'Workspace',
    'agent-full-access': 'Full access',
    auto: 'Auto',
    default: 'Manual',
    acceptEdits: 'Accept edits',
    plan: 'Plan',
    dontAsk: "Don't ask",
    bypassPermissions: 'Bypass permissions',
    build: 'Build',
  }[value] ?? fallback),
  acpModeDescription: (value, fallback) => ({
    'read-only': 'Read and analyze by default. File writes and commands that need more access require approval. Network access is off.',
    agent: 'Read and write inside this workspace and run sandboxed commands. Network and out-of-workspace access require approval.',
    'agent-full-access': 'Access files outside this workspace and use the network without approval prompts. Use only in a trusted environment.',
    auto: 'Use the model classifier to approve or deny permission requests.',
    default: 'Prompt before operations that require approval.',
    acceptEdits: 'Approve file edits automatically; ask about other operations that need permission.',
    plan: 'Plan and inspect without modifying files.',
    dontAsk: 'Do not show permission prompts; deny operations that were not already allowed.',
    bypassPermissions: 'Bypass permission checks. Use only in a trusted environment.',
    build: 'Run tools according to the permissions configured for this Agent.',
  }[value] ?? fallback),
  reasoningOptionLabel: (_value, fallback) => fallback,
  serviceTierLabel: (_value, fallback) => fallback,
  serviceTierDescription: (_value, fallback) => fallback,
  messageMode: 'Message',
  goalMode: 'Goal',
  planMode: 'Plan',
  askFollowUpChanges: 'Ask for follow-up changes',
  shellCommandPlaceholder: 'Type a shell command',
  describeAgentGoal: 'Describe the goal for this agent',
  describePlanFirst: 'Describe what should be planned first',
  openAgentTerminalFirst: 'Open an agent terminal first',
  queuedMessages: count => `${count} queued messages`,
  sendQueuedMessage: 'Send next',
  discardQueuedMessage: 'Discard queued message',
  addContext: 'Add context',
  attachFile: 'Attach file',
  fileContext: 'File context',
  acpSignOut: 'Sign out',
  acpSigningOut: 'Signing out…',
  acpSignOutDescription: 'Sign out of this ACP Agent',
  setObjective: 'Set objective',
  planFirst: 'Plan first',
  clearComposerMode: 'Clear composer mode',
  agentPermissionMode: 'Agent permission mode',
  permissionsPrompt: 'Launch permission profile',
  permissionProfileSavedForNextLaunch: 'Saved for new agents. Running sessions keep the permissions they launched with.',
  permissionProfileRestarting: 'Switching agent permissions…',
  runtimeModeRestarting: 'Restarting Agent…',
  terminalProfileApplying: 'Applying model to Codex Terminal…',
  terminalProfileApplied: 'Codex Terminal model updated.',
  terminalProfileFailed: message => `Codex Terminal model was not changed: ${message}`,
  agentRestartTimedOut: 'Agent restart timed out. The previous Agent remains available; try switching again.',
  permissionRestartHint: 'The running agent restarts to apply these permissions. If it has no resumable session id yet, a fresh session starts.',
  modelAndReasoning: 'Model and reasoning',
  reasoning: 'Reasoning',
  speed: 'Speed',
  startDictation: 'Start dictation',
  stopDictation: 'Stop dictation',
  speechUnsupported: 'Speech recognition is not supported in this browser',
  mobileDictationHint: 'Use the microphone key on the iOS keyboard to dictate.',
  sendMessage: 'Send message',
  interruptAgent: 'Interrupt agent',
  startOrSelectAgent: 'Start or select an agent',
  startOrSelectAgentDescription: 'Projects live on the left. Open any agent terminal without closing the rest of the workspace.',
  historySummary: (_workspaces, _projects, archived, sessions) => `${archived + sessions} history agents`,
  searchHistory: 'Search history',
  noHistoryYet: 'No history yet',
  noHistoryDescription: 'Agents moved off the main page will appear here.',
  historyAgents: 'History Agents',
  historyPagination: 'History pages',
  historyPageStatus: (page, totalPages, totalItems, hasMore) => `${page} / ${totalPages}${hasMore ? '+' : ''} · ${totalItems} loaded`,
  previousPage: 'Previous page',
  nextPage: 'Next page',
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
  showAgents: 'Show agents',
  hideAgents: 'Hide agents',
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
  searchHint: 'Search by Agent title, session title, or project.',
  searchEmptyTitle: 'Start a search',
  searchEmptyDescription: 'Type an Agent title, session title, or project name or path.',
  agents: 'Agents',
  files: 'Files',
  changes: 'Changes',
  changedFiles: 'Changed files',
  trackedChanges: 'Tracked',
  untrackedChanges: 'Untracked',
  reviewChanges: 'Review',
  refreshChanges: 'Refresh changes',
  worktrees: 'Worktrees',
  showWorktrees: 'Show repository worktrees',
  worktreeCurrent: 'current',
  worktreeMain: 'main',
  worktreeDetached: 'detached',
  worktreeLocked: 'locked',
  worktreePrunable: 'prunable',
  worktreeLoadFailed: 'Unable to load repository worktrees',
  gitHistory: 'History',
  gitHistoryEmpty: 'No commits yet',
  gitHistoryNotRepository: 'This project is not a Git repository',
  gitHistoryLoadMore: 'Load more',
  gitHistoryView: 'History view',
  gitHistoryCurrentScope: 'Current',
  gitHistoryAllScope: 'All',
  gitHistoryCurrentBranch: 'Current branch',
  gitHistoryAllBranches: 'All branches',
  gitHistoryCommitMessage: 'Message',
  gitHistoryParent: 'Compare with parent',
  gitHistoryRootCommit: 'Root commit',
  gitHistoryReviewCommit: 'Review commit',
  gitHistoryCommitChanges: count => `${count} file${count === 1 ? '' : 's'} changed`,
  gitHistoryNoChanges: 'No file changes',
  gitHistoryChangesTruncated: 'More changed files were omitted',
  searchOrPathLine: 'Search or path:line',
  searchFilesOrJump: 'Search files or jump to path line',
  openEditors: 'OPEN EDITORS',
  loading: 'Loading...',
  searching: 'Searching...',
  noMatches: 'No matches',
  searchIgnoredFolders: 'Also search ignored folders',
  searchIncomplete: timeoutMs => `Search stopped early. Current timeout: ${Math.round(timeoutMs / 1000)}s.`,
  terminalSearchPlaceholder: 'Find in terminal',
  terminalSearchPrevious: 'Previous match',
  terminalSearchNext: 'Next match',
  terminalSearchClose: 'Close terminal search',
  terminalSearchCaseSensitive: 'Match case',
  terminalSearchWholeWord: 'Match whole word',
  terminalSearchRegex: 'Use regular expression',
  terminalSearchNoResults: 'No results',
  terminalSearchResults: (current, total) => `${current}/${total}`,
  terminalRecoveryRequesting: 'Loading terminal state…',
  terminalRecoveryInstalling: 'Terminal state received. Restoring screen…',
  terminalRecoveryRetrying: delaySeconds => `Terminal state unavailable. Retrying in ${delaySeconds}s…`,
  terminalRecoveryElapsed: seconds => `Waiting ${seconds}s`,
  terminalRecoveryAttempt: attempt => `Attempt ${attempt}`,
  terminalSessionUnavailable: 'Terminal session unavailable',
  acpPermissionAllow: 'Allow',
  acpPermissionTitle: 'Agent needs permission',
  acpPermissionTool: 'Requested tool',
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
  refreshFiles: 'Refresh files',
  refreshingFiles: 'Refreshing files…',
  filesRefreshed: 'Files refreshed',
  filesRefreshFailed: 'Files refresh failed',
  refresh: 'Refresh',
  rename: 'Rename',
  copyRelativePath: 'Copy Relative Path',
  copyShareUrl: 'Copy Share URL',
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
  mermaidPanMode: 'Toggle pan mode',
  mermaidEnterFullscreen: 'Open fullscreen diagram',
  mermaidExitFullscreen: 'Close fullscreen diagram',
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
  otherAgents: 'Shell',
  workspace: 'Workspace:',
  workspacePathPlaceholder: '/path/to/workspace',
  chooseWorkspaceDirectory: 'Choose workspace folder',
  workspaceDirectoryBrowserFailed: 'Couldn’t read this directory.',
  workspaceDirectoryBrowserHostHint: 'Browse folders on the Farming host.',
  workspaceDirectoryBrowserGo: 'Go to directory',
  workspaceDirectoryBrowserParent: 'Parent directory',
  workspaceDirectoryBrowserEmpty: 'No subdirectories.',
  workspaceDirectoryBrowserTruncated: 'Only the first 500 folders are shown. Enter a more specific path to continue.',
  workspaceDirectoryBrowserSelect: 'Select this folder',
  workspaceMissingTitle: 'Create this workspace?',
  workspaceMissingDescription: 'This directory does not exist yet. Farming can create it and start the Agent there.',
  workspaceCreateAndStart: 'Create & Start',
  workspaceCreating: 'Creating...',
  workspaceCreateFailedTitle: 'Couldn’t create workspace',
  workspaceCreateForbiddenDescription: 'Farming does not have permission to create this directory. Choose another location or update the parent directory permissions.',
  workspaceCreateFailedDescription: 'Farming couldn’t create this directory. Check the path and try again.',
  returnToWorkspace: 'Change Path',
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
  enterFocusMode: '进入沉浸模式',
  exitFocusMode: '退出沉浸模式',
  appModeOpen: '应用模式与全屏',
  appModeTitle: '隐藏浏览器控制',
  appModeDescription: '浏览器支持时可安装为独立应用窗口，也可以临时进入全屏。',
  appModeRecommended: '推荐',
  appModeInstallTitle: '安装 Farming 2',
  appModeInstallDescription: '以后从独立窗口打开，不显示标签栏、地址栏和浏览器扩展。',
  appModeInstallAction: '安装 Farming 2',
  appModeInstallStepOne: '打开 Chrome 右上角 ⋮，选择“投放、保存和分享”。',
  appModeInstallStepTwo: '选择“将网页安装为应用”，以后从 Farming 2 应用图标打开。',
  appModeInstallUnavailableTitle: '无法安装为浏览器应用',
  appModeInstallUnavailableInsecure: '当前部署使用不安全的 HTTP 连接，浏览器无法将其安装为应用。',
  appModeInstallUnavailableBrowser: '当前浏览器没有为此部署提供应用安装入口。',
  appModeFullscreenTitle: '暂时全屏',
  appModeFullscreenDescription: '只为当前窗口隐藏浏览器控制，按 Esc 即可退出。',
  terminalView: '终端',
  transcriptView: '对话',
  switchToTerminal: '切换到终端',
  switchToChat: '切换到对话',
  collapseComposer: '收起输入框',
  restoreComposer: '唤出输入框',
  codexTranscriptSyncing: '正在同步聊天历史...',
  codexTranscriptUnavailable: '无法加载此会话的 Chat 历史。',
  codexTranscriptEmpty: '',
  codexTranscriptWaiting: 'Agent 仍在工作...',
  codexTranscriptProcess: '执行过程',
  codexTranscriptWorking: '处理中',
  codexTranscriptThinking: '思考中',
  codexTranscriptRunning: '运行命令中',
  codexTranscriptReading: '读取文件中',
  codexTranscriptSearching: '搜索中',
  codexTranscriptEditing: '修改文件中',
  codexTranscriptPlanActive: '执行计划中',
  codexTranscriptPlanProgress: (completed, total) => `执行计划 ${completed}/${total}`,
  codexTranscriptFetching: '获取信息中',
  codexTranscriptUsingTool: '调用工具中',
  codexTranscriptWorkedFor: duration => `Worked for ${duration}`,
  codexTranscriptProcessCount: count => `${count} 个事件`,
  codexTranscriptCopyDetails: '复制详情',
  codexTranscriptCopiedDetails: '已复制',
  codexTranscriptCopyAnswer: '复制答复',
  codexTranscriptCopiedAnswer: '已复制答复',
  codexTranscriptReviewChanges: 'Review',
  codexTranscriptShowChanges: '展开文件改动',
  codexTranscriptLoadingChanges: '正在加载准确改动…',
  codexTranscriptKeepChange: '保留',
  codexTranscriptRevertChange: '撤销',
  codexTranscriptChangeKept: '已保留',
  codexTranscriptChangeReverted: '已撤销',
  codexTranscriptShowMoreFiles: count => `显示另外 ${count} 个文件`,
  codexGoalTitle: '目标',
  codexGoalEmpty: '没有活动目标',
  codexGoalOpen: '打开目标控制',
  codexGoalObjective: '目标内容',
  codexGoalStatus: '状态',
  codexGoalTokenBudget: 'Token 预算',
  codexGoalNoBudget: '不限制',
  codexGoalUsage: (tokens, seconds) => `${tokens.toLocaleString()} tokens · ${Math.round(seconds / 60)} 分钟`,
  codexGoalStatusLabel: status => ({
    active: '进行中',
    paused: '已暂停',
    blocked: '已阻塞',
    usageLimited: '用量受限',
    budgetLimited: '预算受限',
    complete: '已完成',
  }[status] ?? status),
  codexGoalEdit: '编辑',
  codexGoalStart: '启动',
  codexGoalStop: '停止',
  codexGoalDelete: '删除',
  codexGoalSave: '保存目标',
  codexGoalClear: '清除',
  codexGoalSaving: '保存中...',
  searchProjectsOrAgents: '搜索项目或 Agent',
  clearSearch: '清空搜索',
  projectsAndAgents: '项目与 Agent',
  noAgentsYet: '还没有 Agent。',
  noMatchingProjectsOrAgents: '没有匹配的项目或 Agent。',
  openNavigation: '打开导航',
  closeNavigation: '关闭导航',
  resizeNavigation: '调整导航宽度',
  openOptions: '打开选项',
  openSettings: '设置',
  agentActions: 'Agent 操作',
  appearanceLight: '外观：浅色',
  appearanceDark: '外观：深色',
  languageEnglish: '语言：English',
  languageChinese: '语言：中文',
  pinAgent: '置顶 Agent',
  unpinAgent: '取消置顶',
  pinProject: '置顶项目',
  unpinProject: '取消置顶项目',
  revealInFinder: '在访达中显示',
  revealInFinderFailed: '无法在访达中显示项目',
  createPermanentWorktree: '创建永久 worktree',
  permanentWorktreeCreated: '已创建永久 worktree',
  permanentWorktreeFailed: '创建永久 worktree 失败',
  markAllAsRead: '全部标为已读',
  renameAgent: '重命名 Agent',
  renameProject: '重命名项目',
  archiveAgent: '归档',
  reorderAgentFailed: '调整 Agent 顺序失败',
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
  sharedLocationUnavailable: path => `无法定位分享路径：${path}`,
  shareLinkExpired: '已过期',
  refreshShareLink: '刷新',
  brandStoryOrigin: 'Farming Code 从一个简单的问题出发：当多个 Coding Agent 同时工作，人不该在终端、编辑器和浏览器标签页之间反复切换。',
  brandStoryPurpose: '它把对话、终端、项目文件与进展放在一个安静的工作空间里，让注意力留在真正重要的事情上。',
  brandGithub: 'GitHub',
  renameInstance: '重命名实例',
  instanceNameTitle: '重命名 Farming 实例',
  instanceNameDescription: '这个名称会显示在此机器的侧边栏和浏览器页签中。',
  instanceNamePlaceholder: '机器名称',
  instanceNameSaveFailed: '无法保存实例名称。',
  mobileShareTitle: '分享页面',
  mobileForwardTitle: '转发当前页面',
  mobileForwardHint: '复制链接，发送给其他人。',
  mobileShareCopyAction: '复制链接',
  mobileShareCopied: '已复制',
  mobileInstallTitle: '添加到主屏幕',
  mobileInstallChromeHint: '确认已使用系统浏览器或 Chrome 打开当前页面。',
  mobileInstallShareStep: '点浏览器工具栏里的“分享”。',
  mobileInstallMoreStep: '没看到时，点 •••，再点“分享”。',
  mobileInstallAddStep: '选择“添加到主屏幕”。',
  mobileInstallOpenStep: '以后从主屏幕的 Farming 图标进入。',
  mobileShareInstalled: 'Farming 已经作为主屏幕 App 打开。',
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
  removeProject: '移除项目',
  deleteWorktree: '彻底删除 worktree',
  deleteWorktreeQuestion: '彻底删除 worktree？',
  deleteWorktreeDescription: '这会彻底删除该 worktree 及其中的所有文件。',
  forceDelete: '彻底删除',
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
    ask: '新 Codex 会话以 workspace-write 沙箱启动，并对不可信操作询问',
    approve: '新 Codex 会话以 workspace-write 沙箱启动，并在 Codex 请求时询问',
    full: '新 Codex 会话绕过批准和沙箱；仅用于可信沙箱',
    custom: '新 Codex 会话使用 config.toml 中定义的权限',
    default: '新 Claude Code 会话使用默认设置',
    auto: '新 Claude Code 会话以 auto 权限模式启动',
    acceptEdits: '新 Claude Code 会话允许文件编辑，其他高风险操作仍会询问',
    dontAsk: '新 Claude Code 会话在支持时尽量避免交互式批准',
    plan: '新 Claude Code 会话以计划权限模式启动',
    bypassPermissions: '新 Claude Code 会话绕过权限检查；仅用于可信沙箱',
  }[value] ?? fallback),
  acpModeLabel: (value, fallback) => ({
    'read-only': '只读',
    agent: '工作区',
    'agent-full-access': '完全访问',
    auto: '自动',
    default: '手动批准',
    acceptEdits: '接受编辑',
    plan: '计划',
    dontAsk: '不询问',
    bypassPermissions: '绕过权限',
    build: '执行',
  }[value] ?? fallback),
  acpModeDescription: (value, fallback) => ({
    'read-only': '默认只读和分析；写文件或运行需要更高权限的命令时会请求批准，网络默认关闭',
    agent: '可在当前工作区内读写文件并运行沙箱命令；使用网络或访问工作区外内容时会请求批准',
    'agent-full-access': '可访问工作区外文件并使用网络，且不再请求批准；仅用于可信环境',
    auto: '由模型分类器自动批准或拒绝权限请求',
    default: '需要权限的操作会先请求批准',
    acceptEdits: '自动批准文件编辑；其他需要权限的操作仍会询问',
    plan: '只进行规划和检查，不修改文件',
    dontAsk: '不弹出权限询问；未经预先允许的操作会直接拒绝',
    bypassPermissions: '绕过权限检查；仅用于可信环境',
    build: '按照该 Agent 已配置的权限执行工具',
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
  shellCommandPlaceholder: '输入 Shell 命令',
  describeAgentGoal: '描述这个 Agent 的目标',
  describePlanFirst: '描述需要先规划的事情',
  openAgentTerminalFirst: '先打开一个 Agent 终端',
  queuedMessages: count => `${count} 条排队消息`,
  sendQueuedMessage: '当前轮后发送',
  discardQueuedMessage: '丢弃排队消息',
  addContext: '添加上下文',
  attachFile: '附加文件',
  fileContext: '文件上下文',
  acpSignOut: '退出登录',
  acpSigningOut: '正在退出…',
  acpSignOutDescription: '退出当前 ACP Agent 登录',
  setObjective: '设置目标',
  planFirst: '先做计划',
  clearComposerMode: '清除输入模式',
  agentPermissionMode: 'Agent 权限模式',
  permissionsPrompt: '启动权限 profile',
  permissionProfileSavedForNextLaunch: '已保存给新 Agent。运行中的会话保留启动时的权限。',
  permissionProfileRestarting: '正在切换 Agent 权限…',
  runtimeModeRestarting: '正在重启 Agent…',
  terminalProfileApplying: '正在应用 Codex Terminal 模型…',
  terminalProfileApplied: 'Codex Terminal 模型已更新。',
  terminalProfileFailed: message => `Codex Terminal 模型未修改：${message}`,
  agentRestartTimedOut: 'Agent 重启超时。原 Agent 仍然可用，请重新切换。',
  permissionRestartHint: '运行中的 Agent 会重启以应用权限；如果还没有可 resume 的 Session ID，则启动一个新会话。',
  modelAndReasoning: '模型与推理',
  reasoning: '推理',
  speed: '速度',
  startDictation: '开始语音输入',
  stopDictation: '停止语音输入',
  speechUnsupported: '当前浏览器不支持语音识别',
  mobileDictationHint: '请点 iOS 键盘上的麦克风进行听写。',
  sendMessage: '发送消息',
  interruptAgent: '中止 Agent',
  startOrSelectAgent: '启动或选择一个 Agent',
  startOrSelectAgentDescription: '项目在左侧。打开任意 Agent 终端时，不会关闭其他工作区。',
  historySummary: (_workspaces, _projects, archived, sessions) => `${archived + sessions} 个 History Agents`,
  searchHistory: '搜索历史记录',
  noHistoryYet: '还没有历史记录',
  noHistoryDescription: '从主页面移出的 Agent 会出现在这里。',
  historyAgents: 'History Agents',
  historyPagination: '历史记录分页',
  historyPageStatus: (page, totalPages, totalItems, hasMore) => `第 ${page} / ${totalPages}${hasMore ? '+' : ''} 页 · 已载入 ${totalItems} 条`,
  previousPage: '上一页',
  nextPage: '下一页',
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
  showAgents: '展开 Agent',
  hideAgents: '隐藏 Agent',
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
  searchHint: '可按 Agent 标题、会话标题或项目搜索。',
  searchEmptyTitle: '开始搜索',
  searchEmptyDescription: '输入 Agent 标题、会话标题，或项目名称、路径。',
  agents: 'Agent',
  files: '文件',
  changes: '变更',
  changedFiles: '变更文件',
  trackedChanges: '已跟踪',
  untrackedChanges: '未跟踪',
  reviewChanges: 'Review',
  refreshChanges: '刷新变更',
  worktrees: '工作树',
  showWorktrees: '查看仓库工作树',
  worktreeCurrent: '当前',
  worktreeMain: '主工作树',
  worktreeDetached: '游离',
  worktreeLocked: '已锁定',
  worktreePrunable: '可清理',
  worktreeLoadFailed: '无法加载仓库工作树',
  gitHistory: '历史',
  gitHistoryEmpty: '还没有提交',
  gitHistoryNotRepository: '当前项目不是 Git 仓库',
  gitHistoryLoadMore: '加载更多',
  gitHistoryView: '历史视图',
  gitHistoryCurrentScope: '当前',
  gitHistoryAllScope: '全部',
  gitHistoryCurrentBranch: '当前分支',
  gitHistoryAllBranches: '所有分支',
  gitHistoryCommitMessage: '提交说明',
  gitHistoryParent: '与父提交比较',
  gitHistoryRootCommit: '根提交',
  gitHistoryReviewCommit: 'Review 提交',
  gitHistoryCommitChanges: count => `${count} 个文件有变化`,
  gitHistoryNoChanges: '没有文件变化',
  gitHistoryChangesTruncated: '还有部分变更文件未展示',
  searchOrPathLine: '搜索或路径:行号',
  searchFilesOrJump: '搜索文件或跳转到路径行号',
  openEditors: '打开的编辑器',
  loading: '加载中...',
  searching: '搜索中...',
  noMatches: '无匹配',
  searchIgnoredFolders: '同时在已忽略目录中搜索',
  searchIncomplete: timeoutMs => `搜索提前停止（当前超时：${Math.round(timeoutMs / 1000)} 秒）`,
  terminalSearchPlaceholder: '在终端中查找',
  terminalSearchPrevious: '上一个匹配',
  terminalSearchNext: '下一个匹配',
  terminalSearchClose: '关闭终端搜索',
  terminalSearchCaseSensitive: '区分大小写',
  terminalSearchWholeWord: '全词匹配',
  terminalSearchRegex: '使用正则表达式',
  terminalSearchNoResults: '无结果',
  terminalSearchResults: (current, total) => `${current}/${total}`,
  terminalRecoveryRequesting: '正在获取终端状态…',
  terminalRecoveryInstalling: '终端状态已获取，正在恢复画面…',
  terminalRecoveryRetrying: delaySeconds => `终端状态获取失败，${delaySeconds} 秒后重试…`,
  terminalRecoveryElapsed: seconds => `已等待 ${seconds} 秒`,
  terminalRecoveryAttempt: attempt => `第 ${attempt} 次尝试`,
  terminalSessionUnavailable: '终端会话不可用',
  acpPermissionAllow: '允许',
  acpPermissionTitle: 'Agent 需要权限',
  acpPermissionTool: '请求使用工具',
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
  refreshFiles: '刷新文件',
  refreshingFiles: '正在刷新文件…',
  filesRefreshed: '文件已刷新',
  filesRefreshFailed: '文件刷新失败',
  refresh: '刷新',
  rename: '重命名',
  copyRelativePath: '复制相对路径',
  copyShareUrl: '拷贝分享 URL',
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
  mermaidPanMode: '切换平移模式',
  mermaidEnterFullscreen: '全屏查看图表',
  mermaidExitFullscreen: '退出全屏查看',
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
  codingAgents: 'Coding Agent',
  otherAgents: 'Shell',
  workspace: '工作区：',
  workspacePathPlaceholder: '/工作区/路径',
  chooseWorkspaceDirectory: '选择工作区目录',
  workspaceDirectoryBrowserFailed: '无法读取这个目录。',
  workspaceDirectoryBrowserHostHint: '浏览 Farming Host 上的目录。',
  workspaceDirectoryBrowserGo: '转到目录',
  workspaceDirectoryBrowserParent: '上级目录',
  workspaceDirectoryBrowserEmpty: '没有子目录。',
  workspaceDirectoryBrowserTruncated: '仅显示前 500 个目录，请输入更具体的路径继续浏览。',
  workspaceDirectoryBrowserSelect: '选择此目录',
  workspaceMissingTitle: '创建这个工作区？',
  workspaceMissingDescription: '这个目录尚不存在。Farming 可以创建目录，并在其中启动 Agent。',
  workspaceCreateAndStart: '创建并启动',
  workspaceCreating: '正在创建…',
  workspaceCreateFailedTitle: '无法创建工作区',
  workspaceCreateForbiddenDescription: 'Farming 没有权限创建这个目录。请选择其他位置，或调整父目录权限。',
  workspaceCreateFailedDescription: 'Farming 无法创建这个目录。请检查路径后重试。',
  returnToWorkspace: '修改路径',
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
