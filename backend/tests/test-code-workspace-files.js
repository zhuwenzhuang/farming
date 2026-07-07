const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
}

function run() {
  const appSource = read('src/App.tsx');
  const workspaceSource = [
    'src/components/CodeWorkspace.tsx',
    'src/components/code/CodeComposer.tsx',
    'src/components/code/CodeMainArea.tsx',
    'src/components/code/CodeOverlays.tsx',
    'src/components/code/CodeSidebar.tsx',
    'src/components/code/agent-list-state.ts',
    'src/components/code/agent-row-state.ts',
    'src/components/code/agent-terminal-inference.ts',
    'src/components/code/agent-kind.ts',
    'src/components/code/agent-working-state.ts',
    'src/components/code/capabilities.ts',
    'src/components/code/composer-message.ts',
    'src/components/code/composer-submit.ts',
    'src/components/code/composer-history.ts',
    'src/components/code/composer-keyboard.ts',
    'src/components/code/composer-profile.ts',
    'src/components/code/copy.ts',
    'src/components/code/focus-retry.ts',
    'src/components/code/HistoryPanel.tsx',
    'src/components/code/main-page-session.ts',
    'src/components/code/menu-model.ts',
    'src/components/code/menu-position.ts',
    'src/components/code/SearchPanel.tsx',
    'src/components/code/model.ts',
    'src/components/code/session-display.ts',
    'src/components/code/types.ts',
    'src/components/code/useWorkspaceNavigationHistory.ts',
    'src/components/code/workspace-derived.ts',
    'src/components/code/workspace-file-view.ts',
    'src/lib/workspace-share-target.ts',
  ].map(read).join('\n');
  const capabilitiesSource = read('src/components/code/capabilities.ts');
  const basicComposerCapabilities = capabilitiesSource.match(/const BASIC_COMPOSER_CAPABILITIES[\s\S]*?}\n/)?.[0] || '';
  const workspaceNavigationSource = read('src/lib/workspace-navigation-history.ts');
  const responsiveModeSource = read('src/lib/responsive-mode.ts');
  const serverSource = read('backend/server.js');
  const agentManagerSource = read('backend/agent-manager.js');
  const mainPageSessionSource = read('backend/main-page-session.js');
  const inputPartsSource = read('backend/input-parts.js');
  const terminalPaneSource = read('src/components/AgentTerminalPane.tsx');
  const terminalSearchSource = read('src/lib/terminal-search.ts');
  const terminalSessionPoolSource = read('src/lib/terminal-session-pool.ts');
  const usePooledTerminalSource = read('src/hooks/usePooledTerminal.ts');
  const xtermSource = read('src/lib/xterm.ts');
  const fileEditorMonacoSource = read('src/components/files/useFileEditorMonacoController.ts');
  const sidebarSource = read('src/components/Sidebar.tsx');
  const inputDialogSource = read('src/components/InputDialog.tsx');
  const settingsFileExists = fs.existsSync(path.join(__dirname, '../..', 'src/components/Settings.tsx'));
  const stylesSource = read('src/styles/main.css');
  const composerMicStyles = stylesSource.match(/\.code-composer-mic svg \{[\s\S]*?\n\}/)?.[0] || '';
  const darkStylesSource = read('src/styles/code-dark.css');
  const useAgentsSource = read('src/hooks/useAgents.ts');
  const webSocketSource = read('src/hooks/useWebSocket.ts');
  const messagesSource = read('src/types/messages.ts');
  const resumeAgentSessionSource = workspaceSource.match(/const resumeAgentSession = useCallback[\s\S]*?resumeAgentSessionRef\.current = resumeAgentSession/)?.[0] || '';

  assert(
    appSource.includes('<CodeWorkspace') &&
      !appSource.includes('<MapView') &&
      !appSource.includes('<Sidebar') &&
      !appSource.includes('<SessionModal'),
    'App should route the primary experience through the Code-style workspace instead of map/sidebar/modal terminal'
  );

  assert(
    workspaceSource.includes('useWorkspaceNavigationHistory()') &&
      workspaceSource.includes('recordWorkspaceNavigationAgent(activeTerminalId)') &&
      workspaceSource.includes('recordWorkspaceNavigationFile({') &&
      workspaceSource.includes('recordWorkspaceNavigationFileCursor') &&
      workspaceSource.includes('beginWorkspaceNavigation(direction)') &&
      workspaceSource.includes('pruneWorkspaceNavigationEntries(entry => workspaceNavigationAgentIds.has(entry.agentId))') &&
      workspaceSource.includes('if (!workspaceNavigationAgentIds.has(entry.agentId)) return false') &&
      workspaceSource.includes('} catch {\n      return false\n    }\n  }, [\n    clearSearch,\n    closeSidebarForMobile,') &&
      !workspaceSource.includes('focusWorkspaceFilesSearch(entry.agentId, entry.filePath)') &&
      workspaceSource.includes('restoreWorkspaceNavigationEntry(currentEntry)') &&
      workspaceSource.includes('workspaceNavigationShortcutDirection(event)') &&
      workspaceSource.includes('consumeWorkspaceNavigationShortcut(event)') &&
      workspaceSource.includes('event.stopImmediatePropagation()') &&
      workspaceNavigationSource.includes('WORKSPACE_NAVIGATION_MAX_ENTRIES = 50') &&
      workspaceNavigationSource.includes("kind: 'agent'") &&
      workspaceNavigationSource.includes("kind: 'file'") &&
      workspaceNavigationSource.includes('shouldReplaceWorkspaceNavigationEntry') &&
      workspaceNavigationSource.includes('WORKSPACE_NAVIGATION_CURSOR_SETTLE_MS') &&
      workspaceNavigationSource.includes("event.key === '-' || event.key === '_' || event.code === 'Minus'") &&
      workspaceNavigationSource.includes('return event.shiftKey ? 1 : -1') &&
      fileEditorMonacoSource.includes('event.reason !== monaco.editor.CursorChangeReason.Explicit') &&
      fileEditorMonacoSource.includes("event.source === 'api'"),
    'Workspace navigation history should keep an in-memory agent/file stack, dedupe cursor movement, suppress programmatic Monaco cursor events, and expose back/forward shortcuts'
  );

  assert(
    agentManagerSource.includes('if (workspace && !sessionWorkspace) return false') &&
      agentManagerSource.includes('if (workspace && workspace !== sessionWorkspace) return false') &&
      agentManagerSource.includes('observeAgentStateChange(sessionId') &&
      agentManagerSource.includes('attemptCodexProviderSessionResolution(agentId') &&
      !agentManagerSource.includes('startCodexProviderSessionResolver') &&
      !agentManagerSource.includes('setTimeout(tick'),
    'Codex temporary session resolution should be triggered by agent state changes and wait for workspace metadata before claiming a real session id'
  );

  assert(
    appSource.includes('cycleOpenTerminal') &&
      appSource.includes('const CODEX_SKIN_KEYBOARD_SHORTCUTS_ENABLED = false') &&
      appSource.includes('if (!CODEX_SKIN_KEYBOARD_SHORTCUTS_ENABLED) return []') &&
      appSource.includes("useKeyboard(globalShortcuts, CODEX_SKIN_KEYBOARD_SHORTCUTS_ENABLED && effectiveDialog === 'none')") &&
      !appSource.includes("{ key: '[', handler") &&
      !appSource.includes("{ key: ']', handler") &&
      appSource.includes("key: '[', meta: true") &&
      appSource.includes("key: ']', meta: true") &&
      !appSource.includes("key: ','") &&
      !appSource.includes("key: 's', handler: openSettingsView") &&
      !appSource.includes('openSettingsView') &&
      appSource.includes('allowInInput: true') &&
      appSource.includes('allowInTerminal: true') &&
      !appSource.includes("key: '0'") &&
      !appSource.includes("key: '0', ctrl: true") &&
      appSource.includes('shortcuts.push({ key, ctrl: true') &&
      appSource.includes('hiddenMainStartRequestedRef') &&
      appSource.includes("ws.startAgent('bash', undefined, true)") &&
      appSource.includes('const handleRestartMainAgent') &&
      appSource.includes('ws.restartMainAgent(command)') &&
      appSource.includes('onRestartMainAgent={handleRestartMainAgent}') &&
      !appSource.includes("setActiveWorkspaceView('settings')") &&
      appSource.includes("setActiveWorkspaceView('projects')\n    setDialog('input')") &&
      appSource.includes('activeView={activeWorkspaceView}') &&
      appSource.includes("dialogOpen={effectiveDialog !== 'none'}") &&
      appSource.includes('onWorkspaceViewChange={setActiveWorkspaceView}') &&
      appSource.includes('const handleForkAgent') &&
      appSource.includes('/api/agents/${agentId}/fork') &&
      appSource.includes('onForkAgent={handleForkAgent}') &&
      appSource.includes('const handleRenameAgent') &&
      appSource.includes('/api/agents/${agentId}') &&
      appSource.includes('onRenameAgent={handleRenameAgent}') &&
      appSource.includes('const handleUpdateAgentFlags') &&
      appSource.includes('onUpdateAgentFlags={handleUpdateAgentFlags}') &&
      appSource.includes('const handleStartAgent = useCallback((command: string, workspace: string, extras?: StartAgentExtras)') &&
      appSource.includes('ws.startAgent(command, workspace, false, extras)') &&
      appSource.includes('function isOpenableAgent(agent: Agent)') &&
      appSource.includes("agent.status !== 'dead' && agent.status !== 'stopped'") &&
      appSource.includes('const nextAgent = ws.agents.find(agent => !agent.isMain && isOpenableAgent(agent) && !pending.beforeIds.has(agent.id))') &&
      appSource.includes('mustStartMain={false}') &&
      !appSource.includes('Failed to resume Main Agent') &&
      !appSource.includes('body: JSON.stringify({ asMain: true })') &&
      appSource.includes('flags.archived === true') &&
      appSource.includes('didApplyAgentDeeplinkRef') &&
      appSource.includes("new URLSearchParams(window.location.search).get('agent')") &&
      appSource.includes('openTerminalIdsRef') &&
      appSource.includes('didAutoOpenInitialTerminalRef') &&
      appSource.includes('lastActiveWorkspaceRef') &&
      appSource.includes('inputDialogReturnFocusRef') &&
      appSource.includes('focusVisibleTarget') &&
      appSource.includes('restoreInputDialogFocus') &&
      appSource.includes('document.querySelectorAll<HTMLElement>(\'[data-testid="code-agent-row"]\')') &&
      appSource.includes('onClose={closeInputDialog}') &&
      appSource.includes('lastActiveWorkspaceRef.current = workspace') &&
      appSource.includes('lastActiveWorkspaceRef.current)') &&
      appSource.includes('if (didAutoOpenInitialTerminalRef.current) return') &&
      appSource.includes('const nextMain = ws.agents.find(agent => agent.isMain && !agent.archived && !pending.beforeIds.has(agent.id))') &&
      appSource.includes('if (!ws.agents.some(agent => !agent.isMain && isOpenableAgent(agent)))') &&
      appSource.includes('ws.agents.find(agent => !agent.isMain && isOpenableAgent(agent))?.id') &&
      appSource.includes('if (current && openTerminalIds.includes(current)) return current') &&
      appSource.includes('return openTerminalIds[0] ?? null') &&
      appSource.includes('closedIndex') &&
      appSource.includes('data-testid="app-toast"') &&
      !appSource.includes('window.alert') &&
      appSource.includes('keyMap={keyMap}') &&
      appSource.includes('keyboardShortcutsEnabled={CODEX_SKIN_KEYBOARD_SHORTCUTS_ENABLED}'),
    'App should keep Codex skin global shortcuts behind a default-off switch while preserving workspace navigation, settings routing, and terminal lifecycle wiring'
  );

  assert(
    useAgentsSource.includes('a.id !== mainAgentId') &&
      useAgentsSource.includes('&& !a.isMain') &&
      useAgentsSource.includes('&& !a.archived') &&
      useAgentsSource.includes("&& a.status !== 'dead'") &&
      useAgentsSource.includes("&& a.status !== 'stopped'"),
    'Agent keyboard mapping should never include hidden, archived, stopped, or dead agents while the backend state catches up'
  );

  assert(
    messagesSource.includes("type: 'restart-main-agent'") &&
      messagesSource.includes("command: 'bash' | 'zsh' | 'codex' | 'claude'") &&
      webSocketSource.includes('const restartMainAgent = useCallback') &&
      webSocketSource.includes("sendMessage({ type: 'restart-main-agent', command })") &&
      webSocketSource.includes('restartMainAgent,'),
    'WebSocket client should expose the unique Main Agent restart command without allowing arbitrary commands'
  );

  assert(
      workspaceSource.includes('code-project-list') &&
      !workspaceSource.includes('code-project-add') &&
      workspaceSource.includes('keyMap: Map<string, string>') &&
      workspaceSource.includes('keyboardShortcutsEnabled: boolean') &&
      workspaceSource.includes('if (!keyboardShortcutsEnabled) return shortcuts') &&
      workspaceSource.includes('if (!keyboardShortcutsEnabled) return') &&
      workspaceSource.includes('keyboardShortcutsEnabled={keyboardShortcutsEnabled}') &&
      workspaceSource.includes('keyboardShortcutsEnabled && <kbd>N</kbd>') &&
      workspaceSource.includes('keyboardShortcutsEnabled && <kbd>/</kbd>') &&
      workspaceSource.includes('const shortcutHint = keyboardShortcutsEnabled') &&
      !workspaceSource.includes("agent.isMain ? '0'") &&
      workspaceSource.includes('const visibleAgents = useMemo(() => agents.filter(agent => !agent.isMain), [agents])') &&
      workspaceSource.includes('const hiddenMainAgent = useMemo(() => agents.find(agent => agent.isMain) ?? null, [agents])') &&
      !workspaceSource.includes('agents={agents}') &&
      workspaceSource.includes('mainAgent={hiddenMainAgent}') &&
      workspaceSource.includes('data-testid="code-main-agent-usage-row"') &&
      workspaceSource.includes('data-testid="code-main-agent-open"') &&
      workspaceSource.includes('data-testid="code-main-agent-restart"') &&
      workspaceSource.includes('data-testid="code-main-agent-restart-menu"') &&
      workspaceSource.includes('onRestartMainAgent(command)') &&
      workspaceSource.includes("['zsh', 'zsh']") &&
      workspaceSource.includes("['claude', 'Claude Code']") &&
      workspaceSource.includes('isAgentListLiveAgent') &&
      workspaceSource.includes('isAgentListArchivedAgent') &&
      workspaceSource.includes('const pinnedItems = displayedProjects') &&
      workspaceSource.includes('data-testid="code-pinned-section"') &&
      workspaceSource.includes('const visibleProjectSections = displayedProjects.filter(project => (') &&
      workspaceSource.includes('const sortedAgents = project.agents.filter(agent => !agent.pinned)') &&
      !workspaceSource.includes('if ((a.id === activeTerminalId) !== (b.id === activeTerminalId))') &&
      !workspaceSource.includes('const aActive = a.id === activeTerminalId') &&
      !workspaceSource.includes('const bActive = b.id === activeTerminalId') &&
      workspaceSource.includes('dialogOpen: boolean') &&
      workspaceSource.includes('isOverlayShortcutTarget') &&
      workspaceSource.includes('isTerminalShortcutTarget') &&
      workspaceSource.includes('agentShortcutKeys') &&
      workspaceSource.includes("export type WorkspaceView = 'projects' | 'search' | 'history'") &&
      workspaceSource.includes('openWorkspaceView') &&
      workspaceSource.includes('code-side-view-panel') &&
      !workspaceSource.includes('code-nav-projects') &&
      workspaceSource.includes('code-nav-search') &&
      workspaceSource.includes('code-nav-history') &&
      !workspaceSource.includes('settingsAvailable') &&
      !workspaceSource.includes('code-nav-settings') &&
      workspaceSource.includes('codeCopyForLanguage') &&
      workspaceSource.includes('data-testid="code-options-menu"') &&
      workspaceSource.includes('data-testid="code-sidebar-options"') &&
      workspaceSource.includes('data-testid="code-product-mark"') &&
      workspaceSource.includes('Farming Code') &&
      !workspaceSource.includes('Farming - Codex Web Skin') &&
      workspaceSource.includes('DOGFOOD BETA') &&
      workspaceSource.includes('function compactProductVersion') &&
      workspaceSource.includes('-(\\d+)-g[0-9a-f]+') &&
      workspaceSource.includes('return `${describedVersion[1]}-${describedVersion[2]}`') &&
      workspaceSource.includes("fetch(appPath(`/api/update${force ? '?force=1' : ''}`))") &&
      workspaceSource.includes("fetch(appPath('/api/update/install')") &&
      workspaceSource.includes('copy.upgrade') &&
      workspaceSource.includes('code-product-mark-badge') &&
      workspaceSource.includes('appPath') &&
      !workspaceSource.includes('code-nav-plugins') &&
      !workspaceSource.includes('code-nav-automations') &&
      workspaceSource.includes('/api/settings') &&
      workspaceSource.includes('buildWorkspaceHistory') &&
      workspaceSource.includes('code-history-panel') &&
      workspaceSource.includes('code-history-agents') &&
      !workspaceSource.includes('SettingsPanel') &&
      workspaceSource.includes('code-search-panel') &&
      workspaceSource.includes('searchResultProjects') &&
      workspaceSource.includes('searchHasQuery') &&
      workspaceSource.includes('data-testid="code-search-empty"') &&
      workspaceSource.includes('code-search-result') &&
      workspaceSource.includes('code-search-box') &&
      workspaceSource.includes('searchSelectionIndex') &&
      workspaceSource.includes('handleSearchInputKeyDown') &&
      workspaceSource.includes('closeSearchView') &&
      workspaceSource.includes('focusActiveProjectListTarget') &&
      workspaceSource.includes('activeRow ?? rows[0] ?? projectListRef.current') &&
      workspaceSource.includes("setMainPaneMode('terminal')\n    onWorkspaceViewChange('projects')") &&
      workspaceSource.includes("if (target.kind === 'agent')") &&
      workspaceSource.includes('resumeAgentSessionRef.current(target.provider, target.id)') &&
      workspaceSource.includes("restoreProjectListFocusRef.current = 'active-force'") &&
      workspaceSource.includes("restoreProjectListFocusRef.current = 'list'") &&
      workspaceSource.includes("if (activeView !== 'projects' || searchOpen) return") &&
      workspaceSource.includes("if (restoreTarget === 'list')") &&
      workspaceSource.includes('projectListRef.current?.focus({ preventScroll: true })') &&
      workspaceSource.includes('shouldSkipProjectFocusRestore') &&
      workspaceSource.includes("activeElement.closest('.code-context-menu')") &&
      workspaceSource.includes('skipIfFocusMoved') &&
      workspaceSource.includes('retryTimer = window.setTimeout(restoreFocus, 90)') &&
      workspaceSource.includes("}, restoreTarget === 'list' ? 0 : 50)") &&
      workspaceSource.includes("if (activeView !== 'search' && searchOpen)") &&
      workspaceSource.includes("if (activeView === 'projects') return") &&
      workspaceSource.includes('setAgentMenu(null)\n    setProjectMenu(null)\n    setAgentSessionMenu(null)\n    setOptionsMenu(null)\n    closeActiveComposerMenus()') &&
      workspaceSource.includes('if (!dialogOpen) return') &&
      workspaceSource.includes('if (dialogOpen) return') &&
      workspaceSource.includes('onClick={onCloseSearch} aria-label={copy.clearSearch}') &&
      workspaceSource.includes("event.key === 'Escape' && activeView !== 'projects'") &&
      !workspaceSource.includes("activeView === 'settings'") &&
      workspaceSource.includes('openSelectedSearchTarget') &&
      workspaceSource.includes('&& !event.ctrlKey') &&
      workspaceSource.includes('&& !event.metaKey') &&
      workspaceSource.includes('&& !event.altKey') &&
      workspaceSource.includes('&& !event.shiftKey') &&
      workspaceSource.includes('const openTerminalFromWorkspace') &&
      workspaceSource.includes("if (view === 'projects') {\n      expandSidebar()\n      clearSearch()") &&
      workspaceSource.includes('clearSearch()') &&
      workspaceSource.includes('onToggleProject(project.id)') &&
      workspaceSource.includes('openVisibleTarget') &&
      workspaceSource.includes('currentProjectListTargetId') &&
      workspaceSource.includes('openAdjacentVisibleTarget') &&
      workspaceSource.includes('handleProjectListKeyDown') &&
      !workspaceSource.includes("event.key.toLowerCase() === 'j'") &&
      !workspaceSource.includes("event.key.toLowerCase() === 'k'") &&
      workspaceSource.includes('activeTerminalIdRef') &&
      workspaceSource.includes('activeTerminalIdRef.current = activeTerminalId') &&
      workspaceSource.includes('visibleProjectListTargets.findIndex(target => workspaceTargetId(target) === currentTargetId)') &&
      workspaceSource.includes('resumeAgentSessionRef.current(target.provider, target.id)') &&
      workspaceSource.includes('code-sidebar-resizer') &&
      workspaceSource.includes('beginSidebarResize') &&
      workspaceSource.includes('sidebarCollapsed') &&
      workspaceSource.includes('code-sidebar-toggle') &&
      workspaceSource.includes('code-sidebar-toggle-icon') &&
      workspaceSource.includes("import { ShareQrButton } from './ShareQrButton'") &&
      workspaceSource.includes('<ShareQrButton copy={copy} sidebarCollapsed={sidebarCollapsed} shareTarget={shareTarget} />') &&
      workspaceSource.includes('workspaceShareTargetFromSearch(window.location.search)') &&
      workspaceSource.includes('const shareTarget = useMemo<WorkspaceShareTarget | null>') &&
      workspaceSource.includes("kind: 'file'") &&
      workspaceSource.includes("kind: 'agent'") &&
      workspaceSource.includes('const restoreWorkspaceShareTarget = useCallback') &&
      workspaceSource.includes('workspaceFileOpenTargetFromShareTarget(target)') &&
      workspaceSource.includes('shareTargetRestoreAttemptsRef.current >= 20') &&
      !workspaceSource.includes("{sidebarCollapsed ? '>' : '<'}") &&
      workspaceSource.includes('code-folder-icon') &&
      !workspaceSource.includes("{collapsed ? '▸' : '▾'}") &&
      workspaceSource.includes("event.key.toLowerCase() === 'b'") &&
      workspaceSource.includes('lastProjectWorkspace') &&
      workspaceSource.includes('setLastProjectWorkspace(activeProjectWorkspace)') &&
      workspaceSource.includes('const agentCreationWorkspace = activeAgent?.isMain') &&
      workspaceSource.includes('? lastProjectWorkspace ?? projects[0]?.workspace') &&
      workspaceSource.includes(': activeProjectWorkspace ?? lastProjectWorkspace ?? projects[0]?.workspace') &&
	      workspaceSource.includes('data-testid="code-new-agent"') &&
	      workspaceSource.includes('onClick={event => onNewAgent(agentCreationWorkspace, undefined, event.currentTarget)}') &&
	      workspaceSource.includes('data-testid="code-project-new-agent"') &&
	      workspaceSource.includes('data-testid="code-project-actions"') &&
	      workspaceSource.includes('data-testid="code-project-new-agent-menu"') &&
	      !workspaceSource.includes("launchMenuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()") &&
	      workspaceSource.includes('code-project-agent-launch-${option.name}') &&
	      workspaceSource.includes('onStartAgent(command, project.workspace)') &&
	      workspaceSource.includes('onNewAgent(project.workspace, undefined, event.currentTarget)') &&
	      workspaceSource.includes('agentMenu') &&
	      workspaceSource.includes('projectMenu') &&
      workspaceSource.includes('contextMenuRef') &&
      workspaceSource.includes('handleContextMenuKeyDown') &&
      workspaceSource.includes("event.key === 'ArrowDown'") &&
      workspaceSource.includes("event.key === 'Tab'") &&
      workspaceSource.includes("event.key === 'Home'") &&
      workspaceSource.includes('closeContextMenuAndRestoreFocus') &&
      workspaceSource.includes('openAgentContextMenu') &&
      workspaceSource.includes('openProjectContextMenu') &&
      workspaceSource.includes('data-testid="code-agent-context-menu"') &&
	      workspaceSource.includes('data-testid="code-project-context-menu"') &&
	      workspaceSource.includes('data-project-id={project.id}') &&
	      workspaceSource.includes('focusAgentRow') &&
	      workspaceSource.includes('focusProjectTitle') &&
	      workspaceSource.includes('projectNames') &&
	      workspaceSource.includes('copy.renameProject') &&
	      workspaceSource.includes('copy.archiveChats') &&
	      !workspaceSource.includes('Open First Agent') &&
      !workspaceSource.includes('Open First Session') &&
      !workspaceSource.includes('Collapse Project') &&
      !workspaceSource.includes('Expand Project') &&
	      !workspaceSource.includes('New Agent in Project') &&
	      workspaceSource.includes('New Agent') &&
	      workspaceSource.includes('Archive chats') &&
	      workspaceSource.includes('const archivableAgents = contextMenuProject.agents.filter(agent => !agent.isMain)') &&
      workspaceSource.includes('onUpdateAgentFlags(agent.id, { archived: true })') &&
      workspaceSource.includes('Pin Agent') &&
      workspaceSource.includes('Unpin Agent') &&
      workspaceSource.includes('Archive') &&
      !workspaceSource.includes('disabled={contextMenuAgent.isMain}') &&
      workspaceSource.includes('Mark as unread') &&
      workspaceSource.includes('Mark as read') &&
      workspaceSource.includes('code-history-agents') &&
      workspaceSource.includes('code-archived-run-card') &&
      workspaceSource.includes('code-archived-run-continue') &&
      workspaceSource.includes('continueArchivedRun') &&
      workspaceSource.includes('code-archived-agent-open') &&
      workspaceSource.includes('openArchivedAgent') &&
      workspaceSource.includes('onOpenArchivedAgent') &&
      workspaceSource.includes('code-archived-agent-restore') &&
      workspaceSource.includes('restoreArchivedAgent') &&
      workspaceSource.includes('pendingRestoredFocusAgentRef') &&
      workspaceSource.includes("onWorkspaceViewChange('projects')") &&
      workspaceSource.includes("type RenameDialogState =") &&
      workspaceSource.includes('Rename Agent') &&
      workspaceSource.includes('Rename project') &&
      workspaceSource.includes('data-testid="code-rename-dialog"') &&
      workspaceSource.includes('data-testid="code-rename-input"') &&
      workspaceSource.includes('data-testid="code-kill-dialog"') &&
      workspaceSource.includes('data-testid="code-delete-worktree-dialog"') &&
      workspaceSource.includes('trapFocusInContainer') &&
      workspaceSource.includes('renameDialogRef') &&
      workspaceSource.includes('killDialogRef') &&
      workspaceSource.includes('deleteWorktreeDialogRef') &&
      workspaceSource.includes('onKeyDown={event => trapFocusInContainer(event, renameDialogRef.current)}') &&
      workspaceSource.includes('onKeyDown={event => trapFocusInContainer(event, killDialogRef.current)}') &&
      workspaceSource.includes('onKeyDown={event => trapFocusInContainer(event, deleteWorktreeDialogRef.current)}') &&
      workspaceSource.includes('const target = renameDialog') &&
      workspaceSource.includes("if (target.kind === 'agent') focusAgentRow(target.agentId)") &&
      workspaceSource.includes("if (target.kind === 'project') focusProjectTitle(target.projectId)") &&
      workspaceSource.includes('let initializedSelection = false') &&
      workspaceSource.includes("if (renameDialog.kind === 'project')") &&
      workspaceSource.includes('input.setSelectionRange(cursorPosition, cursorPosition)') &&
      workspaceSource.includes('focusAgentRow(renameDialog.agentId)') &&
      workspaceSource.includes('const agentId = killDialog?.agentId') &&
      workspaceSource.includes('if (agentId) focusAgentRow(agentId)') &&
      workspaceSource.includes('killCancelButtonRef') &&
      workspaceSource.includes('deleteWorktreeCancelButtonRef') &&
      workspaceSource.includes('if (renameDialog || killDialog || deleteWorktreeDialog)') &&
      !workspaceSource.includes('window.prompt') &&
      !workspaceSource.includes('window.confirm') &&
      workspaceSource.includes('Copy working directory') &&
      workspaceSource.includes('data-testid="code-copy-toast"') &&
      !workspaceSource.includes('Copy session ID') &&
      !workspaceSource.includes('Copy deeplink') &&
      !workspaceSource.includes('Open in new window') &&
      !workspaceSource.includes('window.alert') &&
      workspaceSource.includes('writeClipboardText') &&
      workspaceSource.includes("copyContextMenuValue(projectWorkspaceForAgent(contextMenuAgent), { kind: 'agent', id: contextMenuAgent.id })") &&
      workspaceSource.includes("if (focusTarget?.kind === 'agent') focusAgentRow(focusTarget.id)") &&
      workspaceSource.includes("if (focusTarget?.kind === 'agent-session') focusAgentSessionRow(focusTarget.provider, focusTarget.id)") &&
      workspaceSource.includes('pendingArchivedFocusAgentRef') &&
      workspaceSource.includes('if (flags.archived === true) {') &&
      workspaceSource.includes('const sessionHandle = contextMenuAgent.providerSessionKey || resumedAgentSessionIdFromSource(contextMenuAgent.source)') &&
      workspaceSource.includes('if (sessionHandle) removeMainPageAgentSession(sessionHandle)') &&
      workspaceSource.includes('pendingArchivedFocusAgentRef.current = agentId') &&
      workspaceSource.includes('window.setTimeout(() => focusActiveProjectListTargetNow(), 720)') &&
      workspaceSource.includes('if (flags.archived !== true) focusAgentRow(agentId)') &&
      !workspaceSource.includes('buildAgentDeeplink') &&
      workspaceSource.includes('Fork into same worktree') &&
      workspaceSource.includes('Fork into new worktree') &&
      workspaceSource.includes("onForkAgent('same-worktree')") &&
      workspaceSource.includes("onForkAgent('new-worktree')") &&
      workspaceSource.includes('compactContextMenuEntries') &&
      workspaceSource.includes('function ContextMenuEntries') &&
	      workspaceSource.includes('type ContextMenuEntry') &&
	      workspaceSource.includes("icon?: 'rename' | 'archive'") &&
	      workspaceSource.includes('function ContextMenuIcon') &&
	      workspaceSource.includes('agent?.canForkNewWorktree === true') &&
	      workspaceSource.includes('projectCanArchive(contextMenuProject)') &&
	      !workspaceSource.includes('projectCanDeleteWorktree(contextMenuProject)') &&
	      workspaceSource.includes("onDeleteForkWorktreeProject(dialog.workspace, { force: true })") &&
      appSource.includes("appPath('/api/projects/delete-worktree')") &&
      !workspaceSource.includes('Open Terminal') &&
      !workspaceSource.includes('Close Terminal') &&
      !workspaceSource.includes("restoreProjectListFocusRef.current = 'active'\n    onCloseTerminal(contextMenuAgent.id)") &&
      !workspaceSource.includes('disabled={!openTerminalIds.includes(contextMenuAgent.id)}') &&
      workspaceSource.includes('Kill Agent') &&
      workspaceSource.includes('ProjectFilesSection') &&
      workspaceSource.includes('FileEditorPane') &&
      workspaceSource.includes("type MainPaneMode = 'terminal' | 'editor'") &&
      !workspaceSource.includes('watchWorkspaceFiles') &&
      workspaceSource.includes('openProjectFile') &&
      !workspaceSource.includes('handleWorkspaceFileEvent') &&
      workspaceSource.includes('activeOpenAgent') &&
      workspaceSource.includes('visibleOpenAgents') &&
      workspaceSource.includes('className="code-terminal-grid panes-1"') &&
      workspaceSource.includes('tabIndex={0}') &&
      workspaceSource.includes('data-testid="code-composer-approval"') &&
      workspaceSource.includes('data-testid="code-approval-menu"') &&
      workspaceSource.includes('How should this agent handle permissions?') &&
      workspaceSource.includes('updatePermissionMode') &&
      workspaceSource.includes('data-testid="code-composer-model-picker"') &&
      workspaceSource.includes('export function agentKindForCommand(command?: string)') &&
      workspaceSource.includes("if (basename === 'claude') return 'claude'") &&
      workspaceSource.includes('export interface AgentComposerCapabilities') &&
      workspaceSource.includes('export interface AgentActionCapabilities') &&
      workspaceSource.includes('export function capabilitiesForAgent') &&
      workspaceSource.includes('const activeAgentCapabilities = useMemo') &&
      workspaceSource.includes('capabilities: activeAgentCapabilities.composer') &&
      workspaceSource.includes('codexApprovalMode,') &&
      workspaceSource.includes('claudePermissionMode,') &&
      !workspaceSource.includes("const activeLaunchPermissionMode = activeAgent?.launchPermissionMode || ''") &&
      !workspaceSource.includes('effectiveCodexApprovalModeForSession(Boolean(activeAgent), activeLaunchPermissionMode, codexApprovalMode)') &&
      !workspaceSource.includes('effectiveClaudePermissionModeForSession(Boolean(activeAgent), activeLaunchPermissionMode, claudePermissionMode)') &&
      workspaceSource.includes('const showPermissionMode = active && capabilities.permissionMode') &&
      workspaceSource.includes('const showModelPicker = active && capabilities.modelPicker') &&
      workspaceSource.includes('const showPlusMenu = active && capabilities.plusMenu') &&
      workspaceSource.includes('const showSpeechInput = active && capabilities.speechInput && !narrowComposerViewport') &&
      workspaceSource.includes("window.matchMedia('(max-width: 980px)')") &&
      workspaceSource.includes('if (activeAgentCapabilities.composer.permissionMode || activeAgentCapabilities.composer.modelPicker) return') &&
      workspaceSource.includes("return { ...closed, mode: 'default' }") &&
      workspaceSource.includes("fetch(appPath('/api/codex/models'))") &&
      workspaceSource.includes("fetch(appPath('/api/claude/settings'))") &&
      workspaceSource.includes('normalizeClaudeSettingsSummary') &&
      workspaceSource.includes('resolvedClaudeModel') &&
      workspaceSource.includes('resolvedClaudeEffort') &&
      workspaceSource.includes('if (!modelMenuOpen) return undefined') &&
      workspaceSource.includes('return loadCodexModels()') &&
      !workspaceSource.includes('useEffect(() => loadCodexModels(), [loadCodexModels])') &&
      workspaceSource.includes("fetch(appPath('/api/agent-sessions?limit=60'))") &&
      workspaceSource.includes('data-testid="code-model-menu"') &&
      !workspaceSource.includes('data-agent-launch-provider') &&
      !workspaceSource.includes('data-testid="agent-profile-submenu-trigger"') &&
      !workspaceSource.includes('data-testid="agent-profile-submenu"') &&
      workspaceSource.includes('CLAUDE_PERMISSION_MODES') &&
      workspaceSource.includes('CLAUDE_EFFORT_OPTIONS') &&
      workspaceSource.includes('FALLBACK_CLAUDE_MODEL_OPTIONS') &&
      !workspaceSource.includes("displayName: 'Config'") &&
      !workspaceSource.includes("{ value: 'sonnet', label: 'Sonnet'") &&
      !workspaceSource.includes("{ value: 'opus', label: 'Opus'") &&
      !workspaceSource.includes("{ value: 'fable', label: 'Fable'") &&
      workspaceSource.includes('setClaudePermissionMode') &&
      workspaceSource.includes('setClaudeModel') &&
      workspaceSource.includes('setClaudeEffort') &&
      workspaceSource.includes("persistAgentLaunchProfile('claude'") &&
      workspaceSource.includes("const currentServiceTierOptions = agentKind === 'claude'") &&
      workspaceSource.includes('permissionModeOptions') &&
      !workspaceSource.includes('defaultLaunchAgent: provider') &&
      workspaceSource.includes('agentLaunchProfiles') &&
      workspaceSource.includes('data-testid="code-model-submenu-trigger"') &&
      workspaceSource.includes('data-testid="code-model-submenu"') &&
      workspaceSource.includes('data-testid="code-speed-submenu-trigger"') &&
      workspaceSource.includes('data-testid="code-speed-submenu"') &&
      workspaceSource.includes('updateAgentModel') &&
      workspaceSource.includes('updateAgentReasoningEffort') &&
      workspaceSource.includes('updateAgentServiceTier') &&
      workspaceSource.includes('resumeAgentSession') &&
      workspaceSource.includes('mainPageAgentSessions') &&
      workspaceSource.includes("export const CHATS_PROJECT_ID = '__agent_chats__'") &&
      workspaceSource.includes("return session.projectless ? 'Chats'") &&
      workspaceSource.includes('const aIsChats = a.id === CHATS_PROJECT_ID') &&
      workspaceSource.includes('if (aIsChats !== bIsChats) return aIsChats ? 1 : -1') &&
      workspaceSource.includes('DEFAULT_PROJECT_SESSION_LIMIT') &&
      workspaceSource.includes('limitProjectAgentSessions') &&
      workspaceSource.includes('expandedSessionProjectIds') &&
      workspaceSource.includes('setExpandedSessionProjectIds') &&
      workspaceSource.includes('SESSION_DISPLAY_STATE_STORAGE_KEY') &&
      workspaceSource.includes('loadSessionDisplayState') &&
      workspaceSource.includes('saveSessionDisplayState') &&
      workspaceSource.includes('applySessionDisplayOverrides') &&
      workspaceSource.includes('normalizeMainPageSessionKeys') &&
      workspaceSource.includes('mainPageSessionKeys') &&
      workspaceSource.includes('persistMainPageSessionKeys') &&
      workspaceSource.includes('updateMainPageSessionKeys') &&
      !workspaceSource.includes('pendingMainPageLaunchForAgent') &&
      !workspaceSource.includes('resolvePendingMainPageLaunches') &&
      workspaceSource.includes('trackedMainPageAgentKeysRef') &&
      workspaceSource.includes('agent.providerSessionTemporary === true') &&
      workspaceSource.includes('agent.providerSessionKey || resumedAgentSessionIdFromSource(agent.source)') &&
      workspaceSource.includes('refreshAgentSessions') &&
      workspaceSource.includes('agentSessionPinnedOverrides') &&
      workspaceSource.includes('toggleContextMenuAgentSessionPinned') &&
      workspaceSource.includes('archiveContextMenuAgentSession') &&
      workspaceSource.includes('removeMainPageAgentSession') &&
      workspaceSource.includes('syncRemovedMainPageSessionsFromAgentUpdate') &&
      workspaceSource.includes('value.removedMainPageSessionKeys') &&
      workspaceSource.includes('syncRemovedMainPageSessionsFromAgentUpdate(result)') &&
      workspaceSource.includes('addMainPageAgentSession(provider, sessionId)') &&
      workspaceSource.includes('function resumedAgentSource(provider: string, sessionId: string)') &&
      workspaceSource.includes('function resumedAgentSessionIdFromSource(source?: string)') &&
      workspaceSource.includes('visibleAgents.filter(isAgentListLiveAgent)') &&
      workspaceSource.includes('const existingAgent = activeAgents.find(agent => (') &&
      resumeAgentSessionSource.includes("agent.status !== 'dead'") &&
      resumeAgentSessionSource.includes("agent.status !== 'stopped'") &&
      workspaceSource.includes('buildAgentListState') &&
      workspaceSource.includes('liveAgents: activeAgents') &&
      workspaceSource.includes('function claimedAgentSessionKeysForAgents(') &&
      workspaceSource.includes('function claimedAgentSessionKeyByAgentIdForAgents(') &&
      workspaceSource.includes('function dedupeLiveAgentsByRowIdentity(') &&
      workspaceSource.includes('const normalizedLiveAgents = liveAgents.filter(isAgentListLiveAgent)') &&
      !workspaceSource.includes('isAgentListRecoverableStoppedAgent') &&
      workspaceSource.includes('claimedAgentSessionKeyByAgentIdForAgents(normalizedLiveAgents, sessions)') &&
      workspaceSource.includes('mainPageSessionKeys: remoteMainPageSessionKeys') &&
      workspaceSource.includes('const agentListState = useMemo(') &&
      workspaceSource.includes('const mainPageAgentSessions = agentListState.mainPageAgentSessions') &&
      workspaceSource.includes('const unclaimedSearchableAgentSessions = agentListState.searchableAgentSessions') &&
      workspaceSource.includes('const sidebarAgentSessions = agentListState.sidebarAgentSessions') &&
      workspaceSource.includes('const visibleLiveAgents = agentListState.liveAgents') &&
      workspaceSource.includes('claimedAgentSessionKeyByAgentId={agentListState.claimedAgentSessionKeyByAgentId}') &&
      !workspaceSource.includes('visibleProjectAgentSessions') &&
      workspaceSource.includes('projectListProjectsForAgents(visibleLiveAgents, sidebarAgentSessions, projectNames)') &&
      workspaceSource.includes('projectListProjectsForAgents(visibleLiveAgents, unclaimedSearchableAgentSessions, projectNames)') &&
      workspaceSource.includes('limitProjectAgentSessions(\n    projectListProjects') &&
      workspaceSource.includes('historyAgentSessions') &&
      workspaceSource.includes('historyAgentSessionsForSessions(sessions, mainPageSessionKeys, claimedAgentSessionKeys)') &&
      workspaceSource.includes('function historySessionIdentity(session: AgentSessionHistoryItem)') &&
      workspaceSource.includes('function historyAgentIdentity(agent: Agent)') &&
      workspaceSource.includes('code-history-identity') &&
      workspaceSource.includes('visibleSearchTargets') &&
      workspaceSource.includes("kind: 'agent-session'") &&
      workspaceSource.includes("return workspaceTargetId({ kind: 'agent-session', provider: session.provider, id: session.id })") &&
      workspaceSource.includes('openSelectedSearchTarget') &&
	      workspaceSource.includes('data-testid="code-active-session-row"') &&
	      workspaceSource.includes('data-testid="code-session-preview"') &&
	      workspaceSource.includes('AgentSessionPreview') &&
	      !workspaceSource.includes('onFocus={event => onShowAgentSessionPreview(event, session)}') &&
	      !workspaceSource.includes('className="code-agent-pin"') &&
	      workspaceSource.includes('data-testid="code-agent-schedule-clock"') &&
	      workspaceSource.includes('buildAgentRowDisplayState') &&
	      workspaceSource.includes("requiresResume: false") &&
	      workspaceSource.includes("requiresResume: true") &&
	      workspaceSource.includes('const requiresResume = rowState.requiresResume') &&
	      workspaceSource.includes('requires-resume') &&
	      workspaceSource.includes('isNewWorktreeForkAgent') &&
	      workspaceSource.includes('data-testid="code-agent-new-worktree-fork"') &&
		      workspaceSource.includes('copy.newWorktreeFork') &&
		      workspaceSource.includes('role="img"') &&
		      workspaceSource.includes('copy.scheduledTask') &&
		      workspaceSource.includes('function ProjectNewAgentIcon()') &&
		      workspaceSource.includes('function ProjectActionsIcon()') &&
		      workspaceSource.includes("const scheduleTitle = session.schedule?.label || session.schedule?.name || session.schedule?.rrule || ''") &&
	      !workspaceSource.includes('{session.pinned && <span className="code-agent-pin" title="Pinned">Pin</span>}') &&
	      workspaceSource.includes("className={`code-agent-dot ${rowState.lifecycleStatus} ${rowState.turnActive ? 'turn-active' : ''}`}") &&
      workspaceSource.includes('data-testid="code-agent-row-pin"') &&
      workspaceSource.includes('data-testid="code-agent-row-archive"') &&
      workspaceSource.includes('onUpdateAgentFlags?.(agent, { pinned: !rowState.pinned })') &&
      workspaceSource.includes('onUpdateAgentFlags?.(agent, { archived: true })') &&
      workspaceSource.includes('const ageTimestamp = agent.lastActivity ?? agent.startedAt') &&
      workspaceSource.includes('const terminalState = inferAgentTerminalState(agent)') &&
      workspaceSource.includes('const turnActive = terminalState.turnActive') &&
      workspaceSource.includes('statusIndicatorVisible: shouldShowAgentStatusIndicator(agent.status, turnActive)') &&
      workspaceSource.includes('const markAgentReadIfNeeded = useCallback') &&
      workspaceSource.includes('if (agent?.unread) onUpdateAgentFlags(agentId, { unread: false })') &&
      workspaceSource.includes('const [terminalFollowStates, setTerminalFollowStates] = useState<Record<string, TerminalFollowState>>({})') &&
      workspaceSource.includes('const handleTerminalFollowOutputChange = useCallback') &&
      workspaceSource.includes('state.following && !state.hasUnreadOutput') &&
      workspaceSource.includes('const handleDraftChange = useCallback') &&
      workspaceSource.includes('onDraftChange: handleDraftChange') &&
      workspaceSource.includes('onTerminalFollowOutputChange={handleTerminalFollowOutputChange}') &&
      workspaceSource.includes('previousTurnActiveByAgentRef') &&
      workspaceSource.includes('shouldMarkAgentUnreadForTurnTransition({') &&
      workspaceSource.includes('wasTurnActive: wasActive') &&
      workspaceSource.includes('terminalFollowingLatest') &&
      workspaceSource.includes('markAgentReadIfNeeded(agentId)') &&
      workspaceSource.includes('data-testid="code-session-search-result"') &&
      workspaceSource.includes('data-testid="code-session-context-menu"') &&
      workspaceSource.includes('data-testid="code-session-history-card"') &&
      workspaceSource.includes('const historyAgents = buildHistoryAgentItems(archivedRuns, archivedAgents, agentSessions)') &&
      workspaceSource.includes('historyAgents.map(item =>') &&
	      workspaceSource.includes('const [usageCollapsed, setUsageCollapsed] = useState(true)') &&
	      workspaceSource.includes('function providerLocalTokenRate(usageSummary: UsageSummary | null)') &&
	      workspaceSource.includes('function formatCollapsedUsageSummary(tokenRate: number | null, systemStats: SystemStats | null)') &&
	      workspaceSource.includes('parts.push(formatTokenRate(tokenRate))') &&
	      workspaceSource.includes('const localTokenRate = providerLocalTokenRate(usageSummary)') &&
	      workspaceSource.includes('Sum of local token usage reported by providers.') &&
	      workspaceSource.includes('Total local tokens') &&
	      !workspaceSource.includes('function agentOutputRateFromState') &&
	      !workspaceSource.includes('Agent output') &&
	      workspaceSource.includes('data-testid="code-usage-toggle"') &&
      workspaceSource.includes('data-testid="code-usage-summary"') &&
      workspaceSource.includes("title=\"Provider local token usage refreshes periodically.\"") &&
      workspaceSource.includes("collapsed ? collapsedSummary : '5m'") &&
      workspaceSource.includes('data-testid="code-session-show-more"') &&
      workspaceSource.includes('data-testid="code-session-show-less"') &&
      workspaceSource.includes('onToggleProjectSessions(project.id)') &&
      workspaceSource.includes('onClick={() => onResumeSession(session.provider, session.id)}') &&
      workspaceSource.includes('onResume?.(sessionProvider, sessionId)') &&
      workspaceSource.includes('onOpenSessionContextMenu?.(event, sessionProvider, sessionId)') &&
      workspaceSource.includes('onOpenSessionKeyboardMenu?.(event, sessionProvider, sessionId)') &&
      workspaceSource.includes('Open Session') &&
      workspaceSource.includes('Pin chat') &&
      workspaceSource.includes('Unpin chat') &&
      workspaceSource.includes('Archive') &&
      workspaceSource.includes('agentSessionWorkingDirectory(contextMenuAgentSession)') &&
      !workspaceSource.includes('contextMenuProjectFirstTarget') &&
      workspaceSource.includes('data-testid="code-composer-mic"') &&
      workspaceSource.includes('function isCodexAgentWorking(agent: Agent | null | undefined)') &&
      workspaceSource.includes('function isAgentTurnActive(agent: Agent | null | undefined)') &&
      workspaceSource.includes('export function inferAgentTerminalState(agent: Agent | null | undefined)') &&
      workspaceSource.includes("'terminal-output'") &&
      workspaceSource.includes("'terminal-busy'") &&
      workspaceSource.includes('const kind = inferAgentTerminalState(agent).kind') &&
      workspaceSource.includes('const [composerByAgentKey, setComposerByAgentKey]') &&
      workspaceSource.includes('history: ComposerHistoryState') &&
      workspaceSource.includes('history: createDefaultComposerHistoryState()') &&
      workspaceSource.includes('function composerStateKeyForAgent(agent: Agent | null | undefined)') &&
      workspaceSource.includes('function composerStateAliasKeysForAgent(agent: Agent)') &&
      workspaceSource.includes('mergeAgentComposerStates(nextStateByKey[canonicalKey], aliasState)') &&
      workspaceSource.includes('const resolveComposerStateKey = useCallback') &&
      workspaceSource.includes('const canonicalKey = resolveComposerStateKey(composerKey)') &&
      workspaceSource.includes('const activeComposerKey = activeAgent ? composerStateKeyForAgent(activeAgent) :') &&
      workspaceSource.includes('const activeComposerState = activeComposerKey') &&
      workspaceSource.includes('const activePendingFollowUp = activeComposerState.pendingFollowUp') &&
      workspaceSource.includes('const activeAgentTurnActive = useMemo') &&
      workspaceSource.includes('scheduleFocusRetries(focus, { delays: [60] })') &&
      workspaceSource.includes('scheduleFocusRetries(() => {\n      focusAgentRowNow(agentId)\n    }, { delays: [80, 180] })') &&
      workspaceSource.includes('scheduleFocusRetries(focusCancelButton, { runNow: false, delays: [180] })') &&
      workspaceSource.includes('scheduleFocusRetries(focusFirstMenuButton, { delays: [0, 80, 180, 360] })') &&
      workspaceSource.includes('const composerHasAttachmentMessage = composerAttachmentMessageBlocks(composerAttachments).length > 0') &&
      workspaceSource.includes("const composerSubmitAction = activeAgent && !composerAttachmentsUploading && (draft.trim() || composerHasAttachmentMessage)") &&
      workspaceSource.includes('const interruptActiveAgent = useCallback') &&
      workspaceSource.includes('const sendComposerMessageToAgent = useCallback') &&
      workspaceSource.includes('terminalInputPartsForComposerMessage') &&
      workspaceSource.includes("agentKindForCommand(agent.command) === 'shell'") &&
      workspaceSource.includes("capabilitiesForAgent(agent).kind === 'shell'") &&
      workspaceSource.includes("return sendInput(`${message}\\r`, agent.id)") &&
      workspaceSource.includes('return sendInput(terminalInputPartsForComposerMessage(message), agent.id)') &&
      workspaceSource.includes('let submitted = true') &&
      workspaceSource.includes('if (!submitted) return') &&
      !workspaceSource.includes("window.setTimeout(() => sendInput('\\r', agent.id), 80)") &&
      workspaceSource.includes('sendComposerMessageToAgent(activeAgent, message)') &&
      workspaceSource.includes('function createPendingFollowUpMessage(text: string)') &&
      workspaceSource.includes('function removePendingFollowUpMessage(') &&
      workspaceSource.includes('const pendingFollowUpAutoFlushRef = useRef<Record<string, string>>({})') &&
      workspaceSource.includes('const latestDraft = composerTextareaRef.current?.value ?? draft') &&
      workspaceSource.includes('const navigateActiveComposerHistory = useCallback') &&
      workspaceSource.includes('canUseComposerHistoryNavigation(input)') &&
      workspaceSource.includes('navigateComposerHistory(activeComposerState.history, direction, input.value)') &&
      workspaceSource.includes('const message = pending.messages.find(item => item.id === messageId)') &&
      workspaceSource.includes('sendComposerMessageToAgent(activeAgent, message.text)') &&
      workspaceSource.includes('pendingFlushes.push({ agent, composerKey, message: nextMessage })') &&
      workspaceSource.includes('sendComposerMessageToAgent(agent, message.text)') &&
      !workspaceSource.includes("pending.messages.join('\\n\\n')") &&
      workspaceSource.includes('submitAction: composerSubmitAction') &&
      workspaceSource.includes('onInterrupt: interruptActiveAgent') &&
      workspaceSource.includes('pendingFollowUp: {') &&
      workspaceSource.includes('data-testid="code-pending-followup-row"') &&
      workspaceSource.includes('data-testid="code-pending-followup"') &&
      workspaceSource.includes('data-testid="code-pending-followup-steer"') &&
      workspaceSource.includes('data-testid="code-pending-followup-discard"') &&
      workspaceSource.includes('data-action={submitAction}') &&
      workspaceSource.includes('submitIsInterrupt ? onInterrupt : onSubmit') &&
      workspaceSource.includes('copy.interruptAgent') &&
      workspaceSource.includes('code-composer-stop-icon') &&
      workspaceSource.includes('SpeechRecognition') &&
      workspaceSource.includes('toggleSpeechInput') &&
      workspaceSource.includes('recognition.onresult') &&
      workspaceSource.includes('transcript.trim()') &&
      workspaceSource.includes('function ComposerMicIcon') &&
      workspaceSource.includes('listening ? COMPOSER_MIC_FILLED_PATH : COMPOSER_MIC_REGULAR_PATH') &&
      workspaceSource.includes('M8 10.9995C9.654 10.9995 11 9.65351 11 7.99951V3.99951') &&
      basicComposerCapabilities.includes('speechInput: true') &&
      workspaceSource.includes('focusComposerTextarea()\n    }') &&
      workspaceSource.includes('autoSizeComposerTextarea') &&
      workspaceSource.includes('textarea.scrollHeight') &&
      workspaceSource.includes('textarea.style.overflowY') &&
      workspaceSource.includes('data-testid="code-composer-add"') &&
      workspaceSource.includes('data-testid="code-composer-plus-menu"') &&
      workspaceSource.includes('data-testid="code-composer-attach-file"') &&
      workspaceSource.includes('data-testid="code-composer-goal-mode"') &&
      workspaceSource.includes('data-testid="code-composer-plan-mode"') &&
      workspaceSource.includes('plusMenuRef') &&
      workspaceSource.includes('composerTextareaRef') &&
      workspaceSource.includes('focusComposerTextarea') &&
      workspaceSource.includes('focusComposerTextarea()') &&
      workspaceSource.includes('closeComposerMenuOnBlur') &&
      workspaceSource.includes('event.currentTarget.contains(nextTarget)') &&
      workspaceSource.includes('onBlur={onComposerMenuBlur}') &&
      workspaceSource.includes('event.key === \'Escape\' && (plusMenuOpen || approvalMenuOpen || modelMenuOpen)') &&
      workspaceSource.includes("if (isOverlayShortcutTarget(target) && event.key !== 'Escape') return") &&
      workspaceSource.includes('handleComposerMenuKeyDown') &&
      workspaceSource.includes('event.stopPropagation()') &&
      workspaceSource.includes('data-testid="code-speed-submenu"') &&
      workspaceSource.includes('onKeyDown={onComposerMenuKeyDown}') &&
      !workspaceSource.includes('Learn more') &&
      !workspaceSource.includes('help.openai.com') &&
      workspaceSource.includes('handleAttachmentFiles') &&
      workspaceSource.includes('handlePasteAttachment') &&
      workspaceSource.includes('const composerAttachments = activeComposerState.attachments') &&
      workspaceSource.includes('composerMessageWithAttachments(latestDraft, composerAttachments)') &&
      workspaceSource.includes('history: addComposerHistoryEntry(state.history, latestDraft)') &&
      workspaceSource.includes('onNavigateHistory: navigateActiveComposerHistory') &&
      workspaceSource.includes('data-testid="code-composer-attachments"') &&
      workspaceSource.includes('data-testid="code-composer-attachment"') &&
      workspaceSource.includes('onRemoveAttachment: removeComposerAttachment') &&
      workspaceSource.includes('attachments: [...state.attachments, initialAttachment]') &&
      workspaceSource.includes('onPasteAttachment: handlePasteAttachment') &&
      workspaceSource.includes("fetch(composerAppPath('/api/attachments/image')") &&
      workspaceSource.includes('Image path: ${attachment.path}') &&
      workspaceSource.includes('formatComposerMessage') &&
      workspaceSource.includes("mode: 'default'") &&
      workspaceSource.includes('isComposerImeCompositionEvent(event, compositionActive)') &&
      workspaceSource.includes('shouldSuppressComposerEnterAfterComposition(event, lastCompositionEndAtRef.current)') &&
      workspaceSource.includes('shouldSubmitComposerEnter(event, compositionActive, lastCompositionEndAtRef.current)') &&
      workspaceSource.includes('POST_COMPOSITION_ENTER_SUPPRESS_MS') &&
      workspaceSource.includes('event.nativeEvent?.keyCode === 229') &&
      workspaceSource.includes('modelPickerPane') &&
      workspaceSource.includes("'.code-model-picker-menu > .code-model-option.selected'") &&
      !workspaceSource.includes('<small>{option.description}</small>') &&
      workspaceSource.includes('copy.serviceTierDescription(option.value, option.description)') &&
      workspaceSource.includes('code-composer-speed-active') &&
      workspaceSource.includes('code-speed-option-icon') &&
      workspaceSource.includes('code-composer-toolbar') &&
      !workspaceSource.includes('setActiveAgentGoal') &&
      !workspaceSource.includes('Set agent goal') &&
      !workspaceSource.includes('code-projects-header') &&
      !workspaceSource.includes('code-traffic') &&
      !workspaceSource.includes('code-thread-tab-select') &&
      !workspaceSource.includes('data-testid="code-thread-close"') &&
      !workspaceSource.includes('code-main-header') &&
      !workspaceSource.includes('code-composer-meta') &&
      !workspaceSource.includes('code-resource-strip') &&
      !workspaceSource.includes('role="button"') &&
      workspaceSource.includes('code-agent-row') &&
      workspaceSource.includes('PROJECT_AGENT_VISIBLE_LIMIT = 5') &&
      workspaceSource.includes('const agentCompressionActive = sidebarCollapsed') &&
      workspaceSource.includes('single-agent projects collapse to "1"') &&
      workspaceSource.includes('function ProjectAgentCompactStrip') &&
      workspaceSource.includes('function PinnedItemCompactStrip') &&
      workspaceSource.includes('data-testid="code-project-agent-strip"') &&
      workspaceSource.includes('data-testid="code-project-agent-compact"') &&
      workspaceSource.includes('data-testid="code-pinned-title"') &&
      workspaceSource.includes('data-testid="code-pinned-agent-compact"') &&
      workspaceSource.includes('data-testid="code-agent-show-more"') &&
      workspaceSource.includes('data-agent-id={agent.id}') &&
      workspaceSource.includes('rowState.statusIndicatorVisible') &&
      workspaceSource.includes('code-project-agent-compact-unread') &&
      workspaceSource.includes('const compactProjectAgents = compactAgents && sortedAgents.length > 0') &&
      workspaceSource.includes('const visibleProjectAgents = compactProjectAgents || projectAgentsExpanded') &&
      workspaceSource.includes('code-project-expanded') &&
      workspaceSource.includes('code-terminal-grid') &&
      workspaceSource.includes('code-composer') &&
      workspaceSource.includes('onClick={event => onNewAgent(agentCreationWorkspace, undefined, event.currentTarget)}'),
    'CodeWorkspace should expose real left-rail actions, Project Files, agent context-menu actions, project-scoped agent creation, keyboard agent navigation, single active terminal pane, and composer'
  );

  assert(
    !sidebarSource.includes('Task List') &&
      !sidebarSource.includes('Priority') &&
      !sidebarSource.includes('Real-time') &&
      !sidebarSource.includes('Logs') &&
      !sidebarSource.includes('Warnings') &&
      !sidebarSource.includes('Zombies') &&
      !sidebarSource.includes('Billing'),
    'Legacy Sidebar should not keep disabled placeholder buttons for unimplemented actions'
  );

  assert(
    mainPageSessionSource.includes('function resumedAgentSource(provider, sessionId)') &&
      serverSource.includes("const MAIN_AGENT_RESTART_COMMANDS = new Set(['bash', 'zsh', 'codex', 'claude'])") &&
      serverSource.includes('function restartMainAgent(ws, command)') &&
      serverSource.includes("case 'restart-main-agent'") &&
      serverSource.includes("case 'interrupt-agent'") &&
      serverSource.includes("routePath(BASE_PATH, '/api/attachments/image')") &&
      serverSource.includes("express.raw({ type: 'image/*', limit: '12mb' })") &&
      serverSource.includes('IMAGE_ATTACHMENT_RETENTION_MS') &&
      serverSource.includes('cleanupExpiredImageAttachments') &&
      serverSource.includes('IMAGE_ATTACHMENT_FILENAME_RE') &&
      serverSource.includes('agentManager.interruptAgent(data.agentId)') &&
      serverSource.includes("const { inputPartsFromMessage } = require('./input-parts')") &&
      inputPartsSource.includes('function inputPartsFromMessage(data)') &&
      inputPartsSource.includes('Array.isArray(data && data.inputParts)') &&
      inputPartsSource.includes("part.type === 'paste'") &&
      serverSource.includes('if (inputParts.length === 0) return') &&
      serverSource.includes('await agentManager.sendInput(targetAgentId, inputParts)') &&
      !serverSource.includes('const INPUT_PART_DELAY_MS = 24') &&
      !serverSource.includes('for (let index = 0; index < inputParts.length; index += 1)') &&
      serverSource.includes('await agentManager.killAgent(currentMain.id)') &&
      serverSource.includes('await agentManager.startAgent(normalizedCommand, null') &&
      serverSource.includes('function findResumedAgent(provider, sessionId)') &&
      serverSource.includes('function rememberMainPageAgentSession(provider, sessionId)') &&
      mainPageSessionSource.includes("const AUTO_RESUME_AGENT_SESSION_PROVIDERS = new Set(['codex', 'claude'])") &&
      mainPageSessionSource.includes('function mainPageAgentSessionFromKey(key)') &&
      serverSource.includes('function autoResumeMainPageAgentSessions()') &&
      serverSource.includes('findActiveAgentClaimingSession(agentManager.getState().agents') &&
      mainPageSessionSource.includes('agent.providerSessionKey === sessionKey') &&
      serverSource.includes('claimed: true') &&
      serverSource.includes('rememberMainPageSession: false') &&
      serverSource.includes("console.warn('Failed to auto-resume main page agent session:'") &&
      serverSource.includes('void autoResumeMainPageAgentSessions()') &&
      serverSource.includes('function isMainAgentSessionWorkspace(session)') &&
      serverSource.includes('const requestedAsMain = req.body && req.body.asMain === true && !shouldFork') &&
      serverSource.includes('const shouldRememberMainPageSession = options.rememberMainPageSession !== false && !shouldFork && !requestedAsMain') &&
      serverSource.includes("return { error: 'session is not a Main Agent session', status: 400 }") &&
      serverSource.includes('if (shouldRememberMainPageSession) rememberMainPageAgentSession(normalizedProvider, sessionId);') &&
      serverSource.includes('return { agentId: existingAgent.id, reused: true }') &&
	      serverSource.includes('wantsMain: resumeAsMain') &&
	      serverSource.includes('source: shouldFork ? `${normalizedProvider}-history-fork:${sessionId}` : resumedAgentSource(normalizedProvider, sessionId)') &&
	      mainPageSessionSource.includes("agent.status !== 'dead'") &&
	      mainPageSessionSource.includes("agent.status !== 'stopped'") &&
	      !resumeAgentSessionSource.includes("agent.status === 'dead' || agent.status === 'stopped'"),
    'Resuming the same Codex/Claude session should reuse only live agents and keep stopped rows out of the input target flow'
  );

  assert(
    terminalPaneSource.includes('usePooledTerminal') &&
      terminalPaneSource.includes('code-terminal-pane') &&
      terminalPaneSource.includes('focusSignal') &&
      !terminalPaneSource.includes('code-terminal-identity') &&
      !terminalPaneSource.includes('code-terminal-maximize') &&
      !terminalPaneSource.includes('onToggleMaximize') &&
      !terminalPaneSource.includes('onClosePane') &&
      terminalPaneSource.includes('resizeAgent(agent.id, cols, rows)') &&
      terminalPaneSource.includes("const clickedTerminalSurface = target instanceof Element && target.closest('.xterm')") &&
      terminalPaneSource.includes("if (!active) onActivate(agent.id, { focusTerminal: false })") &&
      terminalPaneSource.includes('isPrimaryFindShortcut') &&
      terminalPaneSource.includes('function isTerminalFindNavigationShortcut') &&
      terminalPaneSource.includes('function terminalSearchQueryFromSelection') &&
      terminalPaneSource.includes('type TerminalSearchOptionKey') &&
      terminalPaneSource.includes('function terminalSearchOptionShortcut') &&
      terminalPaneSource.includes('terminalSearchOptionButtonClass') &&
      terminalPaneSource.includes('setTerminalSearchOptions(previous => ({') &&
      terminalPaneSource.includes('const selectedQuery = terminalSearchQueryFromSelection(getSelectionNow())') &&
      terminalPaneSource.includes('onKeyDown={handleTerminalSearchKeyDown}') &&
      terminalPaneSource.includes("if (key === 'KeyC') return 'caseSensitive'") &&
      terminalPaneSource.includes("if (key === 'KeyW') return 'wholeWord'") &&
      terminalPaneSource.includes("if (key === 'KeyR') return 'regex'") &&
      !terminalPaneSource.includes("setTerminalSearchQuery('')") &&
      terminalPaneSource.includes("return event.key === 'F3'") &&
      terminalPaneSource.includes('data-testid="code-terminal-search"') &&
      terminalPaneSource.includes('data-testid="code-terminal-search-input"') &&
      terminalPaneSource.includes('data-testid="code-terminal-search-case-sensitive"') &&
      terminalPaneSource.includes('data-testid="code-terminal-search-whole-word"') &&
      terminalPaneSource.includes('data-testid="code-terminal-search-regex"') &&
      terminalPaneSource.includes('aria-pressed={terminalSearchOptions.caseSensitive === true}') &&
      terminalPaneSource.includes('aria-pressed={terminalSearchOptions.wholeWord === true}') &&
      terminalPaneSource.includes('aria-pressed={terminalSearchOptions.regex === true}') &&
      terminalPaneSource.includes("runTerminalSearch(terminalSearchQuery, event.shiftKey ? 'previous' : 'next')") &&
      terminalPaneSource.includes('copy.terminalSearchPlaceholder') &&
      terminalPaneSource.includes('copy.terminalSearchCaseSensitive') &&
      terminalPaneSource.includes('copy.terminalSearchWholeWord') &&
      terminalPaneSource.includes('copy.terminalSearchRegex') &&
      terminalSearchSource.includes('caseSensitive?: boolean') &&
      terminalSearchSource.includes('wholeWord?: boolean') &&
      terminalSearchSource.includes('regex?: boolean') &&
      usePooledTerminalSource.includes('options?: TerminalSearchOptions') &&
      terminalSessionPoolSource.includes('options: TerminalSearchOptions = {}') &&
      xtermSource.includes('caseSensitive: options.caseSensitive === true') &&
      xtermSource.includes('wholeWord: options.wholeWord === true') &&
      xtermSource.includes('regex: options.regex === true') &&
      xtermSource.includes('let lastSearchOptionsKey') &&
      xtermSource.includes('lastSearchOptionsKey !== searchOptionsKey') &&
      terminalPaneSource.includes('data-testid="code-terminal-status-card"') &&
      terminalPaneSource.includes('copy.terminalSessionUnavailable') &&
      terminalPaneSource.includes('retryTerminalAttach') &&
      terminalPaneSource.includes('}, [active, agent.id, focus, onActivate])'),
    'AgentTerminalPane should embed pooled terminals with explicit focus, resize, terminal find, and recoverable error-state wiring, without extra terminal chrome buttons'
  );

  assert(
    webSocketSource.includes("sendMessage({ type: 'interrupt-agent', agentId })") &&
      webSocketSource.includes('interruptAgent,') &&
    messagesSource.includes("type: 'interrupt-agent'") &&
      messagesSource.includes('inputParts?: TerminalInputPart[]') &&
      messagesSource.includes("type: 'paste'") &&
      messagesSource.includes('InterruptAgentMessage') &&
      stylesSource.includes('.code-composer-send.interrupt') &&
      stylesSource.includes('place-items: center') &&
      stylesSource.includes('background: #111') &&
      stylesSource.includes('color: #fff') &&
      stylesSource.includes('background: #8e9294') &&
      stylesSource.includes('.code-composer-send:disabled') &&
      stylesSource.includes('.code-composer-stop-icon'),
    'Codex composer should expose a real interrupt action with send/interrupt/disabled button states'
  );
  assert(
    workspaceSource.includes('const activeAgentCanInterrupt = useMemo') &&
      workspaceSource.includes('activeAgentTurnActive ||') &&
      workspaceSource.includes("activeAgent?.status === 'running'") &&
      workspaceSource.includes("composerAgentKind === 'shell'") &&
      workspaceSource.includes('activeAgentTerminalState.terminalBusy') &&
      !workspaceSource.includes("composerAgentKind === 'codex'\n        || composerAgentKind === 'claude'") &&
      workspaceSource.includes("? 'interrupt'") &&
      workspaceSource.includes('if (!activeAgent || !activeAgentCanInterrupt) return'),
    'Composer should show interrupt only for an active agent turn or a busy shell, not merely an idle running Codex/Claude process'
  );

  const keyboardSource = read('src/hooks/useKeyboard.ts');
  assert(
      keyboardSource.includes('allowInTerminal?: boolean') &&
      keyboardSource.includes('allowInOverlay?: boolean') &&
      keyboardSource.includes('export function isTerminalShortcutTarget') &&
      keyboardSource.includes('export function isTextEditingShortcutTarget') &&
      keyboardSource.includes('export function isDialogShortcutTarget') &&
      keyboardSource.includes('export function isMenuShortcutTarget') &&
      keyboardSource.includes('export function isOverlayShortcutTarget') &&
      keyboardSource.includes("target.closest('[role=\"dialog\"]')") &&
      keyboardSource.includes("target.closest('[role=\"menu\"]')") &&
      keyboardSource.includes("target.closest('.terminal-session-host, .code-terminal-container')") &&
      keyboardSource.includes("target.closest('.code-file-editor, .monaco-editor')") &&
      keyboardSource.includes('shortcut.meta') &&
      keyboardSource.includes('e.metaKey && !e.ctrlKey') &&
      keyboardSource.includes('const shiftMatch = shortcut.shift ? e.shiftKey : !e.shiftKey') &&
      keyboardSource.includes('const altMatch = !e.altKey') &&
      keyboardSource.includes('keyMatch && modifierMatch && shiftMatch && altMatch') &&
      keyboardSource.includes('const isOverlayTarget = isOverlayShortcutTarget(target)') &&
      keyboardSource.includes('if (isOverlayTarget && !shortcut.allowInOverlay) continue') &&
      keyboardSource.includes('if (isTerminalTarget && !shortcut.allowInTerminal) continue'),
    'useKeyboard should preserve terminal/editor input by ignoring ordinary global shortcuts from terminal hosts and file editors'
  );

  assert(
    inputDialogSource.includes('initialWorkspace') &&
      inputDialogSource.includes('initialCommand') &&
      inputDialogSource.includes("normalizeWorkspaceValue(initialWorkspace || '')") &&
      inputDialogSource.includes("import { isMobileTouchViewport } from '@/lib/responsive-mode'") &&
      inputDialogSource.includes('return isMobileTouchViewport()') &&
      responsiveModeSource.includes("window.matchMedia('(any-pointer: coarse)').matches") &&
      responsiveModeSource.includes('navigator.maxTouchPoints > 0') &&
      inputDialogSource.includes('role="dialog"') &&
      inputDialogSource.includes('aria-modal="true"') &&
      inputDialogSource.includes('aria-labelledby="input-dialog-title"') &&
      inputDialogSource.includes('dialogRef') &&
      inputDialogSource.includes('handleDialogKeyDown') &&
      inputDialogSource.includes('moveAgentListFocus') &&
      inputDialogSource.includes("event.key === 'ArrowDown'") &&
      inputDialogSource.includes("event.key === 'Home'") &&
      inputDialogSource.includes("event.key !== 'Tab'") &&
      inputDialogSource.includes('dialog.contains(activeElement)') &&
      inputDialogSource.includes('last?.focus()') &&
      inputDialogSource.includes('onKeyDown={handleDialogKeyDown}') &&
      inputDialogSource.includes('allowInOverlay: true') &&
      inputDialogSource.includes('agentsLoaded') &&
      inputDialogSource.includes('agentLoadFailed') &&
      inputDialogSource.includes('lockStartClick') &&
      inputDialogSource.includes('settingsLoaded') &&
      inputDialogSource.includes('defaultLaunchAgent') &&
      inputDialogSource.includes('effectiveDefaultLaunchAgent') &&
      inputDialogSource.includes('agent-option-${effectiveDefaultLaunchAgent}') &&
	      inputDialogSource.includes("fetch(appPath('/api/agent-sessions?limit=100'))") &&
	      inputDialogSource.includes('canResumeMainAgentSession') &&
	      inputDialogSource.includes('data-testid="main-agent-resume-toggle"') &&
	      inputDialogSource.includes('copy.resumePreviousMainAgent') &&
	      inputDialogSource.includes('resumeStartOptions(agent)') &&
	      inputDialogSource.includes('resolveWorkspaceToStart(workspace, true, mainWorkspaceDefault)') &&
	      inputDialogSource.includes('onStart(agent.name, resolvedWorkspace, resumeStartOptions(agent))') &&
      !inputDialogSource.includes("onStart(agent.name, '')") &&
      inputDialogSource.includes('disabled={mustStartMain && (startClickLocked || !settingsLoaded)}') &&
      inputDialogSource.includes('disabled={startClickLocked}') &&
      inputDialogSource.includes('onStart(selectedAgent.name, resolvedWorkspace)') &&
	      !inputDialogSource.includes("onStart(selectedAgent.name, '')") &&
	      inputDialogSource.includes('data-testid="agent-list-status"') &&
	      inputDialogSource.includes('copy.loadingAgents') &&
	      inputDialogSource.includes('copy.agentListUnavailable') &&
	      inputDialogSource.includes('copy.noSupportedAgentsFound') &&
	      inputDialogSource.includes('aria-label={copy.close}') &&
	      !inputDialogSource.includes('Start [Enter]') &&
	      !inputDialogSource.includes('Back [Esc]') &&
      !inputDialogSource.includes('key-hint-badge">[') &&
      !inputDialogSource.includes('workspace-history-index">[') &&
      !inputDialogSource.includes('[↓][↑]') &&
      inputDialogSource.includes('if (!r.ok) throw new Error'),
    'InputDialog should allow project-scoped New Agent flows to prefill workspace/command and keep agent discovery loading or failure states readable'
  );

  assert(
    !settingsFileExists &&
      !workspaceSource.includes('../Settings') &&
      !workspaceSource.includes('code-settings-view') &&
      !workspaceSource.includes('Remote Engine'),
    'Remote-engine Settings panel should be removed from the Codex workspace'
  );

  assert(
    stylesSource.includes('body.code-mode') &&
    stylesSource.includes('.code-workspace') &&
      stylesSource.includes('--code-sidebar-width') &&
      stylesSource.includes('.code-sidebar-resizer') &&
      stylesSource.includes('.code-workspace.sidebar-collapsed') &&
      stylesSource.includes('.code-sidebar-toggle') &&
      stylesSource.includes('.code-sidebar-toggle-icon::before') &&
      stylesSource.includes('.code-sidebar-footer') &&
	      stylesSource.includes('margin-top: auto') &&
	      stylesSource.includes('flex: 1 1 0') &&
	      stylesSource.includes('padding: 0 2px 72px 0') &&
	      workspaceSource.includes("projectGroup.style.setProperty(\n        '--code-project-sticky-height'") &&
	      workspaceSource.includes('observer?.observe(projectRow)') &&
	      stylesSource.includes('min-height: var(--code-project-sticky-height)') &&
	      stylesSource.includes('.code-agents-section {\n  position: sticky;') &&
	      stylesSource.includes('.code-agents-section {\n  position: sticky;\n  top: var(--code-project-sticky-height);\n  z-index: 24;') &&
      stylesSource.includes('box-sizing: border-box;\n  margin-left: 0;\n  margin-right: 2px;\n  padding-left: 14px;') &&
      stylesSource.includes('.code-file-sticky-shell {\n  position: sticky;\n  top: calc(var(--code-project-sticky-height) + var(--code-agents-sticky-height, 0px));\n  height: 0;\n  z-index: 11;') &&
      stylesSource.includes('.code-product-mark') &&
      stylesSource.includes('grid-template-columns: minmax(0, 1fr) auto') &&
      stylesSource.includes('.code-product-mark-copy') &&
      stylesSource.includes('.code-product-mark-meta') &&
      stylesSource.includes('.code-product-mark-badge') &&
      stylesSource.includes('.code-product-mark-update') &&
      stylesSource.includes('.code-product-mark-collapsed') &&
      stylesSource.includes('.code-sidebar.collapsed') &&
      stylesSource.includes('.code-folder-icon::before') &&
      stylesSource.includes('.code-folder-icon.expanded::before') &&
      stylesSource.includes('.code-side-view-panel') &&
      stylesSource.includes('.code-search-view') &&
      stylesSource.includes('.code-search-result') &&
      stylesSource.includes('.code-history-view') &&
      stylesSource.includes('.code-history-card') &&
      stylesSource.includes('.code-history-card p.code-history-identity') &&
      stylesSource.includes('button.code-history-card') &&
      stylesSource.includes('.code-history-card:focus-visible') &&
      !stylesSource.includes('.code-settings-view') &&
      !stylesSource.includes('.code-settings-button') &&
      stylesSource.includes('.code-agent-row.search-selected') &&
      stylesSource.includes('.code-project-expanded') &&
      stylesSource.includes('.code-context-menu') &&
      stylesSource.includes('.code-rename-dialog') &&
      stylesSource.includes('.code-rename-actions') &&
      stylesSource.includes('.code-kill-dialog') &&
      stylesSource.includes('.code-rename-actions button.danger') &&
      stylesSource.includes('.code-copy-toast') &&
      stylesSource.includes('.app-toast') &&
      !stylesSource.includes('box-shadow: inset 2px 0 0 rgba(95, 111, 69, 0.58);') &&
	      stylesSource.includes('.code-agent-dot.running') &&
	      stylesSource.includes('.code-agent-dot.turn-active') &&
	      stylesSource.includes('animation: code-agent-running-spin 0.9s linear infinite;') &&
	      stylesSource.includes('.code-project-agent-strip') &&
		      stylesSource.includes('.code-project-agent-compact.active') &&
		      stylesSource.includes('.code-project-agent-compact-status.running') &&
		      stylesSource.includes('.code-project-agent-compact-unread') &&
		      stylesSource.includes('.code-project-title-actions') &&
		      stylesSource.includes('.code-project-row:hover .code-project-title-actions') &&
		      stylesSource.includes('.code-project-title-action svg') &&
		      stylesSource.includes('.code-context-menu-icon') &&
		      stylesSource.includes('.code-agent-fork-new-worktree svg') &&
	      !stylesSource.includes('.code-agent-fork-new-worktree::before') &&
	      !stylesSource.includes('.code-agent-fork-new-worktree::after') &&
	      stylesSource.includes('.code-agent-unread') &&
	      stylesSource.includes('.code-agent-row-actions') &&
	      stylesSource.includes('.code-agent-row:hover .code-agent-row-actions') &&
	      stylesSource.includes('.code-agent-row-action.pin.active') &&
	      stylesSource.includes('.code-agent-row-action svg') &&
	      workspaceSource.includes('function HistoryIcon()') &&
	      workspaceSource.includes('<HistoryIcon />') &&
	      workspaceSource.includes('function AgentPinIcon()') &&
	      workspaceSource.includes('function AgentArchiveIcon()') &&
	      workspaceSource.includes('function AgentNewWorktreeForkIcon()') &&
	      workspaceSource.includes('<AgentNewWorktreeForkIcon />') &&
	      workspaceSource.includes('<AgentPinIcon />') &&
      workspaceSource.includes('<AgentArchiveIcon />') &&
      darkStylesSource.includes("body.code-mode[data-appearance='dark'] .code-agent-row-action") &&
      stylesSource.includes('.code-session-preview') &&
      stylesSource.includes('.code-usage-panel.collapsed') &&
      stylesSource.includes('.code-usage-summary') &&
      stylesSource.includes('.code-usage-chevron.expanded') &&
	      stylesSource.includes('width: min(320px, calc(100vw - 32px));') &&
      stylesSource.includes('.main-agent-resume-option') &&
      stylesSource.includes('.code-session-preview-header') &&
      stylesSource.includes('.code-history-card.archived') &&
      stylesSource.includes('.code-files-section') &&
      stylesSource.includes('.code-file-editor') &&
      stylesSource.includes('.code-terminal-pane') &&
      stylesSource.includes('.code-composer-approval') &&
      stylesSource.includes('.code-composer-model-picker') &&
      stylesSource.includes('.code-model-picker-menu') &&
      stylesSource.includes('.code-model-nested-trigger') &&
      !stylesSource.includes('.code-agent-submenu') &&
      stylesSource.includes('.code-model-submenu') &&
      stylesSource.includes('.code-speed-submenu') &&
      stylesSource.includes('.code-composer-speed-active') &&
      stylesSource.includes('.code-speed-option-label') &&
      stylesSource.includes('.code-speed-option-icon') &&
      stylesSource.includes('.code-composer-mic') &&
      composerMicStyles.includes('fill: currentColor;') &&
      !composerMicStyles.includes('stroke-width') &&
      stylesSource.includes('.code-pending-followup') &&
      stylesSource.includes('.code-pending-followup-actions') &&
      stylesSource.includes('.code-plus-menu') &&
      stylesSource.includes('.code-plus-menu button:focus-visible') &&
      stylesSource.includes('.code-approval-option:focus-visible') &&
      stylesSource.includes('.code-model-option:focus-visible') &&
      stylesSource.includes('.code-composer-mode-chip') &&
      stylesSource.includes('.code-composer-toolbar') &&
      !stylesSource.includes('.code-composer-goal') &&
      stylesSource.includes('resize: both') &&
      stylesSource.includes('body.code-mode .input-dialog') &&
      stylesSource.includes('body.code-mode .workspace-history-index') &&
      stylesSource.includes('body.code-mode .workspace-history-item.active') &&
      !stylesSource.includes('.code-project-add') &&
      !stylesSource.includes('.code-projects-header') &&
      !stylesSource.includes('.code-main-header') &&
      !stylesSource.includes('.code-composer-plus') &&
      !stylesSource.includes('.code-composer-meta') &&
      !stylesSource.includes('.code-resource-strip') &&
      !stylesSource.includes('.code-traffic') &&
      !stylesSource.includes('.code-thread-tab') &&
      !stylesSource.includes('.code-terminal-actions'),
    'main.css should include Codex mode shell, embedded resizable panes, Code-styled dialogs, and the left-side agent context menu without fake window/tab/terminal chrome'
  );

  assert(
    workspaceSource.includes('const DEFAULT_SIDEBAR_WIDTH = 296') &&
      workspaceSource.includes('const COLLAPSED_SIDEBAR_WIDTH = 64') &&
      workspaceSource.includes('const DESKTOP_AUTO_COLLAPSE_WIDTH = 900') &&
      workspaceSource.includes('const sidebarAutoCollapsedRef = useRef(sidebarCollapsed)') &&
      appSource.includes('useLayoutEffect') &&
      appSource.includes("import { isMobileTouchViewport } from '@/lib/responsive-mode'") &&
      appSource.includes('const mobileViewport = isMobileTouchViewport()') &&
      appSource.includes("document.body.classList.toggle('code-mobile-touch', mobileViewport)") &&
      workspaceSource.includes("import { isMobileTouchViewport } from '@/lib/responsive-mode'") &&
      workspaceSource.includes('return isMobileTouchViewport()') &&
      responsiveModeSource.includes('MOBILE_NAVIGATION_MAX_WIDTH = 980') &&
      responsiveModeSource.includes("window.matchMedia('(any-pointer: coarse)').matches") &&
      responsiveModeSource.includes('navigator.maxTouchPoints > 0') &&
      workspaceSource.includes('function isDesktopAutoCollapseWidth(width: number)') &&
      workspaceSource.includes('const syncSidebarForWorkspaceWidth = (width: number) =>') &&
      workspaceSource.includes('if (isMobileNavigationViewport()) {\n        autoCollapseSidebar()\n        return\n      }') &&
      workspaceSource.includes('if (sidebarAutoCollapsedRef.current)') &&
      workspaceSource.includes('function AgentRail(') &&
      workspaceSource.includes('data-testid="code-agent-rail-item"') &&
      stylesSource.includes('.code-sidebar.collapsed .code-agent-rail') &&
      darkStylesSource.includes(".code-mode[data-appearance='dark'] .code-agent-rail-button") &&
      stylesSource.includes('@media (max-width: 980px) and (any-pointer: coarse)') &&
      stylesSource.includes('@media (min-width: 700px) and (max-width: 980px) and (any-pointer: coarse)') &&
      stylesSource.includes('body.code-mode.code-mobile-touch') &&
      stylesSource.includes('body.code-mode.code-mobile-touch .code-workspace.sidebar-collapsed') &&
      stylesSource.includes('body.code-mode.code-mobile-touch .code-sidebar.collapsed') &&
      stylesSource.includes('transform: translateX(calc(-100% - 18px));') &&
      stylesSource.includes('body.code-mode #root,\n  body.code-mode .app-container,\n  body.code-mode .code-app-shell,\n  body.code-mode .code-workspace') &&
      stylesSource.includes('width: var(--app-visual-width, 100vw);') &&
      stylesSource.includes('height: var(--app-visual-height, 100dvh);') &&
      stylesSource.includes('top: var(--app-visual-offset-top, 0px);') &&
      stylesSource.includes('@media (min-width: 700px) and (max-width: 980px) and (any-pointer: coarse) {\n  .code-workspace {\n    grid-template-columns: minmax(0, 1fr);') &&
      stylesSource.includes('@media (max-width: 980px) and (any-pointer: fine)') &&
      stylesSource.includes('body.code-mode .input-dialog {\n    width: min(92vw, 560px);') &&
      stylesSource.includes('body.code-mode .input-dialog {\n    max-height: var(--app-visual-height, 100dvh);') &&
      !stylesSource.includes('@media (max-width: 640px), (max-width: 980px) and (pointer: coarse)'),
    'Collapsed desktop sidebar should stay narrow, auto-collapse on constrained desktop width, and expose live agent rail shortcuts without entering the mobile drawer layout'
  );

  assert(
    darkStylesSource.includes(".code-agent-dot.turn-active {\n  background: transparent;") &&
      darkStylesSource.includes('border-top-color: var(--code-dark-success);') &&
      darkStylesSource.includes('.code-pending-followup') &&
      darkStylesSource.includes('.code-copy-toast') &&
      darkStylesSource.includes('.app-toast') &&
      darkStylesSource.includes('.code-rename-dialog') &&
      darkStylesSource.includes('.code-file-save-confirm-dialog') &&
      darkStylesSource.includes('.code-editor-context-menu') &&
      !darkStylesSource.includes(".code-agent-dot.running,\nbody.code-mode[data-appearance='dark'] .code-agent-dot.turn-active"),
    'Farming Code dark skin should cover transient operation surfaces and preserve the active-turn spinner shape'
  );

  console.log('✓ Code-style workspace files are wired');
}

run();
