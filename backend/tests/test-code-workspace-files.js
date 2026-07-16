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
    'src/components/code/ComposerAttachments.tsx',
    'src/components/code/CodeMainArea.tsx',
    'src/components/code/CodeOverlays.tsx',
    'src/components/code/CodeSidebar.tsx',
    'src/components/code/agent-list-state.ts',
    'src/components/code/agent-row-state.ts',
    'src/components/code/agent-terminal-inference.ts',
    'src/components/code/agent-kind.ts',
    'src/components/code/agent-working-state.ts',
    'src/components/code/AgentWorkPane.tsx',
    'src/components/code/BrandAboutDialog.tsx',
    'src/components/code/capabilities.ts',
    'src/components/code/composer-message.ts',
    'src/components/code/composer-submit.ts',
    'src/components/code/composer-history.ts',
    'src/components/code/composer-keyboard.ts',
    'src/components/code/composer-profile.ts',
    'src/components/code/composer-state.ts',
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
    'src/components/code/useAgentComposerState.ts',
    'src/components/code/useWorkspaceNavigationHistory.ts',
    'src/components/code/workspace-derived.ts',
    'src/components/code/workspace-file-view.ts',
    'src/lib/workspace-share-target.ts',
  ].map(read).join('\n');
  const settingsPanelSource = read('src/components/code/AgentHomesSettingsPanel.tsx');
  const capabilitiesSource = read('src/components/code/capabilities.ts');
  const basicComposerCapabilities = capabilitiesSource.match(/const BASIC_COMPOSER_CAPABILITIES[\s\S]*?}\n/)?.[0] || '';
  const workspaceNavigationSource = read('src/lib/workspace-navigation-history.ts');
  const responsiveModeSource = read('src/lib/responsive-mode.ts');
  const serverSource = read('backend/server.js');
  const agentManagerSource = read('backend/agent-manager.js');
  const mainPageSessionSource = read('backend/main-page-session.js');
  const inputPartsSource = read('backend/input-parts.js');
  const terminalPaneSource = read('src/components/AgentTerminalPane.tsx');
  const transcriptPaneSource = read('src/components/code/CodexTranscriptPane.tsx');
  const agentWorkPaneSource = read('src/components/code/AgentWorkPane.tsx');
  const codeMainAreaSource = read('src/components/code/CodeMainArea.tsx');
  const terminalComposerSource = read('src/components/code/CodeComposer.tsx');
  const acpComposerSource = read('src/components/code/acp/AcpComposer.tsx');
  const acpComposerBehaviorSource = read('src/components/code/acp/acp-composer-behavior.ts');
  const acpComposerStateSource = read('src/components/code/acp/acp-composer-state.ts');
  const acpSessionControlsSource = read('src/components/code/acp/AcpSessionControls.tsx');
  const acpSessionHookSource = read('src/components/code/acp/useAcpSession.ts');
  const acpPermissionSource = read('src/components/code/acp/AcpPermissionCard.tsx');
  const acpTranscriptSource = read('src/components/code/acp/AcpTranscriptPane.tsx');
  const acpProgressTimelineSource = read('src/components/code/acp/acp-progress-timeline.ts');
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
    webSocketSource.includes("sendMessage({ type: 'focus-agent', agentId, refreshState: true })") &&
      messagesSource.includes('refreshState?: boolean'),
    'focusing an Agent should refresh its backend-derived Terminal profile instead of keeping launch defaults from an early recovery snapshot'
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
      appSource.includes('const [pendingTerminalOpen, setPendingTerminalOpen]') &&
      appSource.includes("if (!displayedAgents.some(agent => agent.id === pendingTerminalOpen.agentId && isOpenableAgent(agent)))") &&
      appSource.includes('activateTerminal(pendingTerminalOpen.agentId, pendingTerminalOpen.options)') &&
      appSource.includes('closeTerminals(data.archivedAgentIds ?? [])') &&
      !appSource.includes('const nextAgent = ws.agents.find(agent => !agent.isMain && isOpenableAgent(agent) && !pending.beforeIds.has(agent.id))') &&
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
      appSource.includes('if (!displayedAgents.some(agent => !agent.isMain && isOpenableAgent(agent)))') &&
      appSource.includes('displayedAgents.find(agent => !agent.isMain && isOpenableAgent(agent))?.id') &&
      appSource.includes('permissionSwitchStateRef.current?.agent.id === current') &&
      appSource.includes('return openTerminalIds[0] ?? null') &&
      appSource.includes('const closeTerminals = useCallback') &&
      appSource.includes('const activeIndex = openIds.indexOf(activeTerminalId ?? \'\')') &&
      appSource.includes('data-testid="app-toast"') &&
      !appSource.includes('window.alert') &&
      appSource.includes('keyMap={keyMap}') &&
      appSource.includes('keyboardShortcutsEnabled={CODEX_SKIN_KEYBOARD_SHORTCUTS_ENABLED}'),
    'App should keep Codex skin global shortcuts behind a default-off switch while preserving workspace navigation, settings routing, and terminal lifecycle wiring'
  );

  assert(
      appSource.includes('const [permissionSwitch, setPermissionSwitch]') &&
      appSource.includes('permissionSwitchRequestRef') &&
      appSource.includes('return [...agents, permissionSwitch.agent]') &&
      appSource.includes('latestRestartDescendant(ws.agents, current.originalAgentId, current.agent)') &&
      appSource.includes('agent.restartedFromAgentIds?.includes(ancestorAgentId)') &&
      appSource.includes('agent.providerSessionId === expectedSession.providerSessionId') &&
      appSource.includes("(agent.providerHomeId || '') === (expectedSession.providerHomeId || '')") &&
      appSource.includes('requestSettled: true') &&
      appSource.includes("kind: runtimeSwitch ? 'runtime' : 'permission'") &&
      appSource.includes('startedAt: Date.now()') &&
      appSource.includes('AGENT_SWITCH_REQUEST_TIMEOUT_MS = 45_000') &&
      appSource.includes('AGENT_SWITCH_OVERLAY_TIMEOUT_MS = 60_000') &&
      appSource.includes('requestController.abort()') &&
      appSource.includes('message: copy.agentRestartTimedOut') &&
      appSource.includes('agentSwitchingKind={permissionSwitch?.kind ?? null}') &&
      appSource.includes('requestFreshStateAt') &&
      appSource.includes('Math.min(hardDeadline, freshStateDeadline)') &&
      appSource.includes('setOpenTerminalIds(ids => ids.map(id => id === agentId ? restartedAgentId : id))') &&
      appSource.includes('setActiveTerminalId(activeId => activeId === agentId ? restartedAgentId : activeId)') &&
      !appSource.includes('openTerminal(data.restartedAgentId)') &&
      workspaceSource.includes('active: Boolean(activeAgent) && !activeAgentPermissionSwitching') &&
      workspaceSource.includes('permissionModeDisabled: Boolean(permissionSwitchingAgentId)') &&
      workspaceSource.includes('message: copy.runtimeModeRestarting') &&
      workspaceSource.includes("runtimeModeRestarting: 'Restarting Agent…'") &&
      workspaceSource.includes('disabled={permissionModeDisabled}') &&
      workspaceSource.includes('moveReplacementState(\n          permissionSwitchReplacement.originalAgentId') &&
      workspaceSource.includes('`acp:${permissionSwitchReplacement.originalAgentId}`') &&
      !workspaceSource.includes('previousActiveTerminalIdRef') &&
      agentManagerSource.includes('permissionRestartInFlight') &&
      agentManagerSource.includes('restartedFromAgentId: agentId') &&
      agentManagerSource.includes('restartedFromAgentIds: Array.from(new Set([') &&
      agentManagerSource.includes('permissionRestartSuppressedAgentIds') &&
      agentManagerSource.includes('emitUpdate: false') &&
      stylesSource.includes('.code-permission-switching') &&
      darkStylesSource.includes('.code-permission-switching'),
    'Permission restarts should keep the old agent visible while pending, replace its runtime id in place, and avoid stealing the current agent or workspace view'
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
      messagesSource.includes("command: 'codex' | 'claude' | 'opencode' | 'qoder' | 'bash' | 'zsh'") &&
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
      workspaceSource.includes('aria-label={copy.search}') &&
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
      workspaceSource.includes("['codex', 'Codex']") &&
      workspaceSource.includes("['opencode', 'OpenCode']") &&
      workspaceSource.includes("['qoder', 'Qoder']") &&
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
      workspaceSource.includes("id: 'options-open-settings'") &&
      workspaceSource.includes('setSettingsPanelOpen(true)') &&
      workspaceSource.includes('data-testid="code-product-mark"') &&
      workspaceSource.includes('Farming Code') &&
      !workspaceSource.includes('Farming - Codex Web Skin') &&
      !workspaceSource.includes('DOGFOOD BETA') &&
      workspaceSource.includes('function compactProductVersion') &&
      workspaceSource.includes('-(\\d+)-g[0-9a-f]+') &&
      workspaceSource.includes('return `${describedVersion[1]}-${describedVersion[2]}`') &&
      workspaceSource.includes("import { BrandAboutDialog } from './BrandAboutDialog'") &&
      workspaceSource.includes('setBrandDialogOpen(true)') &&
      workspaceSource.includes('<BrandAboutDialog copy={copy} version={currentVersionLabel}') &&
      workspaceSource.includes('code-product-mark-badge') &&
      workspaceSource.includes('appPath') &&
      !workspaceSource.includes('code-nav-plugins') &&
      !workspaceSource.includes('code-nav-automations') &&
      workspaceSource.includes('/api/settings') &&
      workspaceSource.includes('buildWorkspaceHistory') &&
      workspaceSource.includes('code-history-panel') &&
      workspaceSource.includes('code-history-agents') &&
      workspaceSource.includes('AgentHomesSettingsPanel') &&
      settingsPanelSource.includes('dangerouslySkipAgentPermissionsByDefault') &&
      settingsPanelSource.includes('dangerousSkipLabel') &&
      settingsPanelSource.includes('saveDangerouslySkipPermissions') &&
      workspaceSource.includes('code-search-panel') &&
      workspaceSource.includes('searchResultProjects') &&
      workspaceSource.includes('searchHasQuery') &&
      !workspaceSource.includes('data-testid="code-search-empty"') &&
      workspaceSource.includes('code-search-result') &&
      workspaceSource.includes('code-sidebar-search-toggle') &&
      workspaceSource.includes('searchSelectionIndex') &&
      workspaceSource.includes('handleSearchInputKeyDown') &&
      workspaceSource.includes('closeSearchView') &&
      workspaceSource.includes('focusActiveProjectListTarget') &&
      workspaceSource.includes('activeRow ?? rows[0] ?? projectListRef.current') &&
      workspaceSource.includes("setMainPaneMode('terminal')\n    onWorkspaceViewChange('projects')") &&
      workspaceSource.includes("if (target.kind === 'agent')") &&
      workspaceSource.includes('resumeAgentSessionRef.current(target.provider, target.id, target.providerHomeId)') &&
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
      workspaceSource.includes('onClick={onClearSearch} aria-label={copy.clearSearch}') &&
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
      workspaceSource.includes('visibleProjectListTargets.findIndex(target => searchTargetHandle(target) === currentTargetId)') &&
      workspaceSource.includes('resumeAgentSessionRef.current(target.provider, target.id, target.providerHomeId)') &&
      workspaceSource.includes('code-sidebar-resizer') &&
      workspaceSource.includes('beginSidebarResize') &&
      workspaceSource.includes('sidebarCollapsed') &&
      workspaceSource.includes('code-sidebar-toggle') &&
      workspaceSource.includes('code-sidebar-toggle-icon') &&
      workspaceSource.includes('ChevronLeftGlyph') &&
      workspaceSource.includes('ChevronRightGlyph') &&
      workspaceSource.includes('ChevronDownGlyph') &&
      workspaceSource.includes("import { ShareQrButton } from './ShareQrButton'") &&
      workspaceSource.includes('<ShareQrButton copy={copy} sidebarCollapsed={sidebarCollapsed} shareTarget={shareTarget} />') &&
      workspaceSource.includes('workspaceShareTargetFromSearch(window.location.search)') &&
      workspaceSource.includes('const shareTarget = useMemo<WorkspaceShareTarget | null>') &&
      workspaceSource.includes("kind: 'file'") &&
      workspaceSource.includes("kind: 'agent'") &&
      workspaceSource.includes('const restoreWorkspaceShareTarget = useCallback') &&
      workspaceSource.includes('workspaceFileOpenTargetFromShareTarget(target)') &&
      workspaceSource.includes("target.kind === 'folder'") &&
      workspaceSource.includes("revealWorkspaceFileInExplorer(resolvedPath.agentId, resolvedPath.filePath, 'directory')") &&
      workspaceSource.includes('resolveWorkspaceSharePath(') &&
      workspaceSource.includes('clearWorkspaceShareTargetSearch(window.location.search)') &&
      workspaceSource.includes('copy.sharedLocationUnavailable(sharedPath)') &&
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
      workspaceSource.includes('onClick={() => startProjectAgent(option.command || option.name)}') &&
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
      workspaceSource.includes("if (focusTarget?.kind === 'agent-session') focusAgentSessionRow(focusTarget.provider, agentSessionId(focusTarget))") &&
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
      workspaceSource.includes('Launch permission profile') &&
      workspaceSource.includes('permissionRestartHint') &&
      workspaceSource.includes('updatePermissionMode') &&
      workspaceSource.includes('launchPermissionMode: nextMode') &&
      workspaceSource.includes('permissionProfileRestarting') &&
      workspaceSource.includes('data-testid="code-composer-model-picker"') &&
      workspaceSource.includes('export function agentKindForCommand(command?: string)') &&
      workspaceSource.includes("if (basename === 'claude') return 'claude'") &&
      workspaceSource.includes('export interface AgentComposerCapabilities') &&
      workspaceSource.includes('export interface AgentActionCapabilities') &&
      workspaceSource.includes('export function capabilitiesForAgent') &&
      workspaceSource.includes('const activeAgentCapabilities = useMemo') &&
      workspaceSource.includes('capabilities: activeAgentCapabilities.composer') &&
      workspaceSource.includes('displayedCodexApprovalMode') &&
      workspaceSource.includes('displayedClaudePermissionMode') &&
      workspaceSource.includes('effectiveCodexApprovalModeForSession(') &&
      workspaceSource.includes('effectiveClaudePermissionModeForSession(') &&
      workspaceSource.includes('activeAgent?.launchPermissionMode') &&
      workspaceSource.includes('codexApprovalMode: displayedCodexApprovalMode') &&
      workspaceSource.includes('claudePermissionMode: displayedClaudePermissionMode') &&
      workspaceSource.includes('const startAgentWithLaunchProfile = useCallback') &&
      workspaceSource.includes('dangerouslySkipPermissions: true') &&
      workspaceSource.includes('onStartAgent={startAgentWithLaunchProfile}') &&
      !workspaceSource.includes("const activeLaunchPermissionMode = activeAgent?.launchPermissionMode || ''") &&
      !workspaceSource.includes('effectiveCodexApprovalModeForSession(Boolean(activeAgent), activeLaunchPermissionMode, codexApprovalMode)') &&
      !workspaceSource.includes('effectiveClaudePermissionModeForSession(Boolean(activeAgent), activeLaunchPermissionMode, claudePermissionMode)') &&
      workspaceSource.includes('const showPermissionMode = active && capabilities.permissionMode') &&
      workspaceSource.includes('const showModelPicker = active && capabilities.modelPicker') &&
      workspaceSource.includes('const showPlusMenu = active && capabilities.plusMenu') &&
      workspaceSource.includes('const showSpeechInput = active') &&
      workspaceSource.includes('&& capabilities.speechInput') &&
      workspaceSource.includes('&& (!mobileComposerViewport || speechSupported)') &&
      workspaceSource.includes('const speechControlAvailable = speechSupported || mobileComposerViewport') &&
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
      workspaceSource.includes('const AGENT_SESSION_PAGE_SIZE = 60') &&
      workspaceSource.includes("params.set('cursor', options.cursor)") &&
      workspaceSource.includes("params.set('fresh', '1')") &&
      workspaceSource.includes("cache: options.fresh ? 'no-store' : 'default'") &&
      workspaceSource.includes("fresh: '1'") &&
      workspaceSource.includes("cache: 'no-store'") &&
      workspaceSource.includes('const loadMoreAgentSessions = useCallback') &&
      workspaceSource.includes('setAgentSessionNextCursor(page.nextCursor)') &&
      workspaceSource.includes('const seen = new Set(current.map(agentSessionId))') &&
      workspaceSource.includes('canLoadMoreAgentSessions={agentSessionsHasMore}') &&
      workspaceSource.includes('canLoadMoreHistoryAgentSessions={agentSessionsHasMore}') &&
      workspaceSource.includes('onLoadMoreHistoryAgentSessions={loadMoreAgentSessions}') &&
      workspaceSource.includes('remaining <= 240') &&
      workspaceSource.includes('onScroll={event => loadMoreNearProjectListEnd(event.currentTarget)}') &&
      workspaceSource.includes('remaining <= 320') &&
      workspaceSource.includes("onScroll={activeView === 'history' ? event => loadMoreHistoryNearEnd(event.currentTarget) : undefined}") &&
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
      workspaceSource.includes('addMainPageAgentSession(provider, sessionId, providerHomeId)') &&
      workspaceSource.includes("function resumedAgentSource(provider: string, sessionId: string, providerHomeId = '')") &&
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
      workspaceSource.includes('projectListProjectsForAgents(visibleLiveAgents, searchableAgentSessions, projectNames)') &&
      workspaceSource.includes('limitProjectAgentSessions(\n    projectListProjects') &&
      workspaceSource.includes('historyAgentSessions') &&
      workspaceSource.includes('historyAgentSessionsForSessions(sessions, mainPageSessionKeys, claimedAgentSessionKeys)') &&
      workspaceSource.includes('function historySessionMeta(session: AgentSessionHistoryItem)') &&
      workspaceSource.includes('function historyAgentMeta(agent: Agent)') &&
      !workspaceSource.includes('code-history-identity') &&
      workspaceSource.includes('visibleSearchTargets') &&
      workspaceSource.includes("kind: 'agent-session'") &&
      workspaceSource.includes("? `home:${session.providerHomeId}:${session.id}`") &&
      workspaceSource.includes('openSelectedSearchTarget') &&
	      workspaceSource.includes('data-testid="code-active-session-row"') &&
	      workspaceSource.includes('data-testid="code-agent-hover-preview"') &&
	      workspaceSource.includes('AgentHoverPreview') &&
	      workspaceSource.includes('previewBrowsingRef.current') &&
	      workspaceSource.includes('compact ? 450 : 1500') &&
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
	      workspaceSource.includes('lastActive: agent.lastActivity || agent.startedAt || 0') &&
      workspaceSource.includes('const terminalState = inferAgentTerminalState(agent)') &&
      workspaceSource.includes('const turnActive = terminalState.turnActive') &&
      workspaceSource.includes('statusIndicatorVisible: shouldShowAgentStatusIndicator(agent.status, turnActive)') &&
      workspaceSource.includes('const markAgentReadIfNeeded = useCallback') &&
      workspaceSource.includes('onUpdateAgentFlags(agentId, { readAttentionSeq: attentionSeq })') &&
      workspaceSource.includes('const [terminalFollowStates, setTerminalFollowStates] = useState<Record<string, TerminalFollowState>>({})') &&
      workspaceSource.includes('const handleTerminalFollowOutputChange = useCallback') &&
      workspaceSource.includes('state.following && !state.hasUnreadOutput') &&
      workspaceSource.includes('const handleDraftChange = useCallback') &&
      workspaceSource.includes('onDraftChange: handleDraftChange') &&
      workspaceSource.includes('onTerminalFollowOutputChange={handleTerminalFollowOutputChange}') &&
      workspaceSource.includes('onAgentReadLatest={markAgentReadIfNeeded}') &&
      workspaceSource.includes('terminalFollowingLatest = state ? state.following && !state.hasUnreadOutput : false') &&
      workspaceSource.includes('markAgentReadIfNeeded(agentId)') &&
	      (workspaceSource.match(/markAgentReadIfNeeded\(/g) || []).length === 2 &&
	      workspaceSource.includes("agentId === activeTerminalId") &&
	      workspaceSource.includes("mainPaneMode === 'terminal'") &&
      workspaceSource.includes('data-testid="code-session-search-result"') &&
      workspaceSource.includes('data-testid="code-session-context-menu"') &&
      workspaceSource.includes('data-testid="code-session-history-card"') &&
	      workspaceSource.includes('const historyAgents = buildHistoryAgentItems(') &&
	      workspaceSource.includes('hasQuery ? mergeHistoryAgentSessions(agentSessions, searchedSessions) : agentSessions') &&
      workspaceSource.includes('displayedHistoryAgents.map(item =>') &&
	      workspaceSource.includes('const [usageCollapsed, setUsageCollapsed] = useState(true)') &&
	      workspaceSource.includes('function providerLocalTokenRate(usageSummary: UsageSummary | null)') &&
	      workspaceSource.includes('function formatCollapsedUsageSummary(') &&
	      workspaceSource.includes('function formatRemainingPercent(value: number | null | undefined)') &&
	      workspaceSource.includes('function formatQuotaRemaining(limit: ProviderQuotaLimit)') &&
	      workspaceSource.includes('function formatQuotaLimitValue(limit: ProviderQuotaLimit)') &&
	      workspaceSource.includes('function formatQuotaLimitTitle(source: string, limit: ProviderQuotaLimit)') &&
	      workspaceSource.includes('function providerHasTokenBurn(provider: UsageProviderSummary)') &&
	      workspaceSource.includes('provider.tokenUsage.tokensPerMinute') &&
	      workspaceSource.includes('function dynamicQuotaProvider(usageSummary: UsageSummary | null)') &&
	      workspaceSource.includes('function formatDynamicQuotaSummary(usageSummary: UsageSummary | null)') &&
	      workspaceSource.includes("return `${Math.round(remainingPercent)}% left`") &&
	      workspaceSource.includes('if (localTokenRate !== null) parts.push(formatTokenRate(localTokenRate))') &&
	      workspaceSource.includes('if (systemStats) parts.push(`CPU ${systemStats.cpu}% / MEM ${systemStats.memory.percentage}%`)') &&
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
      workspaceSource.includes('onClick={() => onResumeSession(session.provider, session.id, session.providerHomeId)}') &&
      workspaceSource.includes('onResume?.(sessionProvider, sessionId, session?.providerHomeId)') &&
      workspaceSource.includes('onOpenSessionContextMenu?.(event, sessionProvider, agentSessionId(session))') &&
      workspaceSource.includes('onOpenSessionKeyboardMenu?.(event, sessionProvider, agentSessionId(session))') &&
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
      workspaceSource.includes("const activeComposerKey = activeAgent?.agentRuntimeMode === 'acp'") &&
      workspaceSource.includes('acpComposerStateKeyForAgent(activeAgent)') &&
      workspaceSource.includes('const activeComposerState = activeComposerKey') &&
      workspaceSource.includes('const activePendingFollowUp = activeComposerState.pendingFollowUp') &&
      workspaceSource.includes('const activeAgentTurnActive = useMemo') &&
      workspaceSource.includes('scheduleFocusRetries(focus, { delays: [60] })') &&
      workspaceSource.includes('scheduleFocusRetries(() => {\n      focusAgentRowNow(agentId)\n    }, { delays: [80, 180] })') &&
      workspaceSource.includes('scheduleFocusRetries(focusCancelButton, { runNow: false, delays: [180] })') &&
      workspaceSource.includes('scheduleFocusRetries(focusFirstMenuButton, { delays: [0, 80, 180, 360] })') &&
      workspaceSource.includes('const composerHasAttachmentMessage = composerAttachmentMessageBlocks(composerAttachments).length > 0') &&
      workspaceSource.includes('const composerSubmitAction = activeCodexTerminalProfileApplying') &&
      workspaceSource.includes("activeAgent && !composerAttachmentsUploading && (draft.trim() || composerHasAttachmentMessage)") &&
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
      workspaceSource.includes('function createPendingFollowUpMessage(text: string, attachments: ComposerPromptAttachment[] = [])') &&
      workspaceSource.includes('function removePendingFollowUpMessage(') &&
      workspaceSource.includes('const pendingFollowUpAutoFlushRef = useRef<Record<string, string>>({})') &&
      workspaceSource.includes('const latestDraft = submittedDraft ?? composerTextareaRef.current?.value ?? draft') &&
      workspaceSource.includes('const navigateActiveComposerHistory = useCallback') &&
      workspaceSource.includes('canUseComposerHistoryNavigation(input)') &&
      workspaceSource.includes('navigateComposerHistory(activeComposerState.history, direction, input.value)') &&
      workspaceSource.includes('const message = pending.messages.find(item => item.id === messageId)') &&
      workspaceSource.includes('sendComposerMessageToAgent(activeAgent, message.text, message.attachments)') &&
      workspaceSource.includes('pendingFlushes.push({ agent, composerKey, message: nextMessage })') &&
      workspaceSource.includes('sendComposerMessageToAgent(agent, message.text, message.attachments)') &&
      !workspaceSource.includes("pending.messages.join('\\n\\n')") &&
      workspaceSource.includes('submitAction: composerSubmitAction') &&
      workspaceSource.includes('onInterrupt: interruptActiveAgent') &&
      workspaceSource.includes('pendingFollowUp: {') &&
      workspaceSource.includes('data-testid="code-pending-followup-row"') &&
      workspaceSource.includes('data-testid="code-pending-followup"') &&
      workspaceSource.includes('data-testid="code-pending-followup-steer"') &&
      workspaceSource.includes('data-testid="code-pending-followup-discard"') &&
      workspaceSource.includes('data-action={submitAction}') &&
      workspaceSource.includes('submitIsInterrupt ? onInterrupt : () => onSubmit(latestDraftRef.current)') &&
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
      workspaceSource.includes('messageBlock: formatAttachedImage({ ...uploaded, name })') &&
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
      workspaceSource.includes('const filesCompressAgents = projectFilesExpanded && isMobileTouchViewport() && sortedAgents.length > 1') &&
      workspaceSource.includes('onFilesCollapsedChange={handleFilesCollapsedChange}') &&
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
      workspaceSource.includes('const compactProjectAgents = (compactAgents || filesCompressAgents) && sortedAgents.length > 0') &&
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
    mainPageSessionSource.includes("function resumedAgentSource(provider, sessionId, providerHomeId = '')") &&
      serverSource.includes("const MAIN_AGENT_RESTART_COMMANDS = new Set(['codex', 'claude', 'opencode', 'qoder', 'bash', 'zsh'])") &&
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
      serverSource.includes("function findResumedAgent(provider, sessionId, providerHomeId = '')") &&
      serverSource.includes("function rememberMainPageAgentSession(provider, sessionId, providerHomeId = '')") &&
      mainPageSessionSource.includes("const AUTO_RESUME_AGENT_SESSION_PROVIDERS = new Set(['codex', 'claude', 'opencode', 'qoder'])") &&
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
      serverSource.includes('if (shouldRememberMainPageSession) rememberMainPageAgentSession(normalizedProvider, sessionId, providerHomeId);') &&
      serverSource.includes('return { agentId: existingAgent.id, reused: true }') &&
      serverSource.includes('wantsMain: resumeAsMain') &&
      serverSource.includes("source: shouldFork ? resumeSource.replace('-history:', '-history-fork:') : resumeSource") &&
      resumeAgentSessionSource.includes("agentRuntimeMode: 'acp'") &&
      resumeAgentSessionSource.includes("acpHistoryMode: 'load'") &&
      serverSource.includes("agentRuntimeMode: options.agentRuntimeMode === 'acp' ? 'acp' : 'terminal'") &&
      mainPageSessionSource.includes("agent.status !== 'dead'") &&
      mainPageSessionSource.includes("agent.status !== 'stopped'") &&
      !resumeAgentSessionSource.includes("agent.status === 'dead' || agent.status === 'stopped'"),
    'Resuming the same Codex/Claude/Qoder session should reuse only live agents and keep stopped rows out of the input target flow'
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
      !terminalPaneSource.includes('CodexTranscriptPane') &&
      !terminalPaneSource.includes('codex-transcript') &&
      !terminalPaneSource.includes('session-text') &&
      !terminalPaneSource.includes('TerminalDisplayMode') &&
      !terminalPaneSource.includes('transcriptAvailability') &&
      agentWorkPaneSource.includes('CodexAppServerTranscriptPane') &&
      agentWorkPaneSource.includes('JsonCliTranscriptPane') &&
      agentWorkPaneSource.includes('AcpTranscriptPane') &&
      agentWorkPaneSource.includes("runtimeState={agent.acpState || ''}") &&
      agentWorkPaneSource.includes("expectHistory={(agent.source || '').startsWith('codex-history:')}") &&
      agentWorkPaneSource.includes('AgentTerminalPane') &&
      agentWorkPaneSource.includes('const appServerChat = isCodexAppServerAgent(agent)') &&
      agentWorkPaneSource.includes("const jsonChat = agent.agentRuntimeMode === 'json'") &&
      agentWorkPaneSource.includes("const acpChat = agent.agentRuntimeMode === 'acp'") &&
      agentWorkPaneSource.includes('data-testid="code-terminal-mode-toggle"') &&
      agentWorkPaneSource.includes('onRuntimeModeChange') &&
      agentWorkPaneSource.includes('agentWorkPaneModeStorageIdentity') &&
      agentWorkPaneSource.includes('providerSessionKey') &&
      agentWorkPaneSource.includes('data-testid="code-permission-switching"') &&
      agentWorkPaneSource.includes("switchingKind === 'runtime' ? copy.runtimeModeRestarting : copy.permissionProfileRestarting") &&
      agentWorkPaneSource.includes('aria-busy={switching}') &&
      transcriptPaneSource.includes("[workingLabel, progressDuration]") &&
      transcriptPaneSource.includes('const effectiveProcessOpen = processOpen') &&
      !transcriptPaneSource.includes("processOpen || (!mobileTouch && turn.status === 'inProgress')") &&
      transcriptPaneSource.includes('if (seconds <= 0) return') &&
      transcriptPaneSource.includes('role="status">{error}</div>') &&
      transcriptPaneSource.includes('&& !error') &&
      transcriptPaneSource.includes("runtimeState === 'connecting' || expectHistory") &&
      transcriptPaneSource.includes('loading || awaitingAcpHistory') &&
      workspaceSource.includes('无法加载此会话的 Chat 历史。') &&
      !workspaceSource.includes('codexTranscriptGoalProgress') &&
      agentWorkPaneSource.includes('data-testid="code-agent-terminal-view"') &&
      agentWorkPaneSource.includes('data-testid="code-agent-chat-view"') &&
      agentWorkPaneSource.includes('onActivate(agent.id, { focusTerminal: false })') &&
      agentWorkPaneSource.includes('active={active}') &&
      agentWorkPaneSource.includes('{!chatMode ? (') &&
      agentWorkPaneSource.includes('{chatMode ? (') &&
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
    codeMainAreaSource.includes("const acpComposerActive = activeAgent?.agentRuntimeMode === 'acp'") &&
      codeMainAreaSource.includes('<AcpComposer {...acpComposerProps} copy={copy} />') &&
      codeMainAreaSource.includes('<CodeComposer {...composerProps} copy={copy} />') &&
      !terminalComposerSource.includes('AcpPermission') &&
      !terminalComposerSource.includes('acpPermission') &&
      acpComposerSource.includes('data-testid="code-acp-composer"') &&
      acpComposerSource.includes('AcpPermissionCard') &&
      acpComposerSource.includes('data-testid="code-acp-command-menu"') &&
      acpComposerSource.includes('session?.availableCommands') &&
      acpComposerSource.includes('<AcpModeControl') &&
      acpComposerSource.includes('<AcpModelControl') &&
      acpComposerSource.includes('className="code-composer-add"') &&
      acpComposerSource.includes('className="code-composer-right-tools"') &&
      acpComposerSource.includes('code-composer-mic') &&
      acpComposerSource.includes('code-composer-send') &&
      acpComposerSource.includes('<ComposerAttachments attachments={attachments}') &&
      acpComposerSource.includes('data-testid="code-acp-composer-file-input"') &&
      acpComposerSource.includes('onPaste={onPasteAttachment}') &&
      acpComposerSource.includes('onNavigateHistory(direction') &&
      !acpComposerSource.includes('(session?.availableCommands || []).map') &&
      acpComposerSource.includes('permissions.map') &&
      acpComposerSource.includes('data-testid="code-acp-composer-goal-mode"') &&
      acpComposerSource.includes('data-testid="code-acp-composer-plan-mode"') &&
      acpComposerSource.includes('data-testid="code-acp-context-window"') &&
      acpComposerSource.includes('data-testid="code-acp-pending-followup"') &&
      acpComposerSource.includes('data-testid="code-acp-pending-followup-discard"') &&
      !acpComposerSource.includes('slashCommands') &&
      acpComposerBehaviorSource.includes("agent.agentRuntimeMode !== 'acp'") &&
      !acpComposerBehaviorSource.includes('terminalInputPartsForComposerMessage') &&
      acpComposerBehaviorSource.includes('formatComposerMessage') &&
      acpComposerBehaviorSource.includes('composerPromptAttachments') &&
      acpComposerBehaviorSource.includes('createPendingFollowUpMessage') &&
      serverSource.includes("data: data.toString('base64')") &&
      serverSource.includes('uri: pathToFileURL(filePath).href') &&
      agentManagerSource.includes('this.acpRuntime.prompt(agentId, prompt)') &&
      workspaceSource.includes("activeAgent?.agentRuntimeMode === 'acp'") &&
      acpComposerStateSource.includes("const ACP_COMPOSER_STATE_PREFIX = 'acp:'") &&
      acpSessionHookSource.includes('/acp-session') &&
      acpSessionHookSource.includes("method: 'PATCH'") &&
      acpSessionControlsSource.includes('data-testid="code-acp-mode"') &&
      acpSessionControlsSource.includes('className={`code-composer-approval ${modeColor(currentModeId)}`}') &&
      acpSessionControlsSource.includes("modeId === 'read-only'") &&
      acpSessionControlsSource.includes("modeId === 'agent-full-access'") &&
      acpSessionControlsSource.includes("option.id === 'mode' || option.category === 'mode'") &&
      acpSessionControlsSource.includes('usesConfigOption && modeConfig') &&
      acpSessionControlsSource.includes("session.provider === 'qoder' && session.agentInfo?.version === '1.0.43'") &&
      acpSessionControlsSource.includes('copy.acpModeDescription(mode.id, mode.description)') &&
      acpSessionControlsSource.includes('className="code-composer-model-picker"') &&
      acpSessionControlsSource.includes('code-model-picker-menu code-composer-menu') &&
      acpSessionControlsSource.includes('code-model-submenu code-composer-menu') &&
      acpSessionControlsSource.includes('code-speed-submenu code-composer-menu') &&
      agentWorkPaneSource.includes("['codex', 'claude', 'opencode', 'qoder'].includes") &&
      inputDialogSource.includes("['codex', 'claude', 'opencode', 'qoder'].includes(selectedAgent.name)") &&
      acpPermissionSource.includes('code-acp-permission-details') &&
      agentWorkPaneSource.includes('refreshSignal={Number(agent.acpSessionRevision) || (agent.acpSessionUpdatedAt ? Date.parse(agent.acpSessionUpdatedAt) : 0)}') &&
      transcriptPaneSource.includes("if (source !== 'acp') timer = window.setInterval(load, 3000)") &&
      acpTranscriptSource.includes("Omit<CodexTranscriptPaneProps, 'source'>") &&
      acpTranscriptSource.includes('groupProcessActions') &&
      !acpTranscriptSource.includes('groupProcessActions={false}') &&
      workspaceSource.includes("activeAgent?.agentRuntimeMode === 'acp'") &&
      workspaceSource.includes('acpComposerStateKeyForAgent(activeAgent)') &&
      workspaceSource.includes('acpComposerStateAliasKeysForAgent(activeAgent)'),
    'ACP chat should own a separate composer and behavior module without changing the Terminal composer contract'
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
  assert(
    transcriptPaneSource.includes('function hasTextSelectionWithin(element: HTMLElement)') &&
      transcriptPaneSource.includes('function preserveCompletedTranscriptTurns(') &&
      transcriptPaneSource.includes('const textSelectionGestureRef = useRef(false)') &&
      transcriptPaneSource.includes('const textSelectionHadRangeRef = useRef(false)') &&
      transcriptPaneSource.includes('const StableCodexTranscriptTurnView = memo(CodexTranscriptTurnView)') &&
      transcriptPaneSource.includes("document.addEventListener('selectionchange', updateSelectionState)") &&
      transcriptPaneSource.includes('onPointerDown={handleTranscriptPointerDown}') &&
      transcriptPaneSource.includes("source === 'acp'") &&
      transcriptPaneSource.includes('mergeAcpTranscript(current, nextTranscript)') &&
      transcriptPaneSource.includes('preserveCompletedTranscriptTurns(current, nextTranscript)') &&
      !transcriptPaneSource.includes('deferredTranscriptRef') &&
      !terminalPaneSource.includes('textSelectionGestureRef') &&
      !terminalComposerSource.includes('textSelectionGestureRef'),
    'Chat transcript selection should pause live rendering without changing Terminal selection or composer behavior'
  );
  assert(
    transcriptPaneSource.includes('data-testid="code-acp-progress-update"') &&
      transcriptPaneSource.includes("source !== 'acp'") &&
      transcriptPaneSource.includes("turn.status === 'inProgress'") &&
      transcriptPaneSource.includes('closedLiveProcessTurnIds') &&
      transcriptPaneSource.includes('acpActionGroupLabel(entry.items)') &&
      acpProgressTimelineSource.includes("return String(item.type || '').trim().toLowerCase() === 'progress'") &&
      acpProgressTimelineSource.includes("return 'Reasoning'") &&
      !terminalPaneSource.includes('code-acp-progress-update'),
    'ACP Chat should show ordered progress prose and compact action groups while a turn is live without changing Terminal rendering'
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
      inputDialogSource.includes("if (agentName === 'opencode') return 'opencode'") &&
      inputDialogSource.includes('effectiveDefaultLaunchAgent') &&
	      inputDialogSource.includes('agent-option-${effectiveDefaultLaunchAgent}') &&
	      inputDialogSource.includes("fetch(appPath('/api/executables'), { cache: 'no-store' })") &&
	      inputDialogSource.includes("fetch(appPath('/api/agent-sessions?limit=100&fresh=1'), { cache: 'no-store' })") &&
	      inputDialogSource.includes('canResumeMainAgentSession') &&
	      inputDialogSource.includes('data-testid="main-agent-resume-toggle"') &&
	      inputDialogSource.includes('copy.resumePreviousMainAgent') &&
	      inputDialogSource.includes('resumeStartOptions(agent)') &&
	      inputDialogSource.includes('resolveWorkspaceToStart(workspace, true, mainWorkspaceDefault)') &&
	      inputDialogSource.includes('onStart(agent.command || agent.name, resolvedWorkspace, { ...(resumeStartOptions(agent) || {}), providerHomeId: selectedHomeId })') &&
      !inputDialogSource.includes("onStart(agent.name, '')") &&
      inputDialogSource.includes('disabled={mustStartMain && (startClickLocked || !settingsLoaded)}') &&
      inputDialogSource.includes('disabled={startClickLocked}') &&
      inputDialogSource.includes('onStart(selectedAgent.command || selectedAgent.name, resolvedWorkspace, { providerHomeId: selectedHomeId })') &&
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
      stylesSource.includes('.code-sidebar-toggle-icon svg') &&
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
      stylesSource.includes('.code-file-sticky-shell {\n  position: sticky;\n  top: calc(var(--code-project-sticky-height) + var(--code-agents-sticky-height, 0px) + var(--code-open-editors-sticky-height, 0px) + var(--code-files-header-height, 25px));\n  height: 0;\n  z-index: 11;') &&
      stylesSource.includes('.code-product-mark') &&
      stylesSource.includes('grid-template-columns: 20px minmax(0, 1fr) auto') &&
      workspaceSource.includes("src={appPath('/farming-2/app-icon-v2-180.png')}") &&
      workspaceSource.includes('className="code-product-logo"') &&
      stylesSource.includes('.code-product-mark-copy') &&
      stylesSource.includes('.code-product-mark-meta') &&
      stylesSource.includes('.code-product-mark-badge') &&
      stylesSource.includes('.code-brand-dialog') &&
      stylesSource.includes('.code-brand-story') &&
      stylesSource.includes('.code-sidebar.collapsed') &&
      stylesSource.includes('.code-folder-icon svg') &&
      stylesSource.includes('.code-side-view-panel') &&
      stylesSource.includes('.code-search-view') &&
      stylesSource.includes('.code-search-result') &&
      stylesSource.includes('.code-history-view') &&
      stylesSource.includes('.code-history-card') &&
      stylesSource.includes('.code-history-actions button svg') &&
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
	      stylesSource.includes('--code-agent-row-action-surface: #e7e8e4;') &&
	      stylesSource.includes('background: linear-gradient(90deg, transparent 0, var(--code-agent-row-action-surface) 21px, var(--code-agent-row-action-surface) 100%);') &&
	      darkStylesSource.includes('body.code-mode[data-appearance=\'dark\'] .code-agent-row:hover .code-agent-row-actions,') &&
	      darkStylesSource.includes('--code-agent-row-action-surface: var(--code-dark-bg-hover);') &&
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
	      stylesSource.includes('.code-agent-hover-preview') &&
      stylesSource.includes('.code-usage-panel.collapsed') &&
      stylesSource.includes('.code-usage-summary') &&
      stylesSource.includes('.code-usage-chevron svg') &&
	      stylesSource.includes('border-radius: 20px;') &&
      stylesSource.includes('.main-agent-resume-option') &&
	      stylesSource.includes('.code-agent-hover-preview-header') &&
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
    stylesSource.includes('.code-composer-collapse-zone:hover .code-composer-collapse') &&
      !stylesSource.includes('.code-composer-shell.collapsible:hover .code-composer-collapse') &&
      stylesSource.includes('.code-composer-restore-bar:hover .code-composer-restore') &&
      stylesSource.includes('.code-composer-restore-bar {\n  position: absolute;\n  left: 0;\n  right: 0;\n  bottom: 0;') &&
      stylesSource.includes('height: 30px;\n  pointer-events: auto;'),
    'Composer collapse and restore controls should appear only from their edge hover zones'
  );

  assert(
    workspaceSource.includes('const DEFAULT_SIDEBAR_WIDTH = 296') &&
      workspaceSource.includes('const MAX_SIDEBAR_WIDTH = 840') &&
      workspaceSource.includes('const MIN_MAIN_PANE_WIDTH = 360') &&
      workspaceSource.includes('const COLLAPSED_SIDEBAR_WIDTH = 52') &&
      workspaceSource.includes('const DESKTOP_AUTO_COLLAPSE_WIDTH = 900') &&
      workspaceSource.includes('const sidebarAutoCollapsedRef = useRef(sidebarCollapsed)') &&
      appSource.includes('useLayoutEffect') &&
      appSource.includes("import { isIOSLikeTouchViewport, isMobileTouchViewport } from '@/lib/responsive-mode'") &&
      appSource.includes('const mobileViewport = isMobileTouchViewport()') &&
      appSource.includes("document.body.classList.toggle('code-mobile-touch', mobileViewport)") &&
      workspaceSource.includes("import { isMobileTouchViewport } from '@/lib/responsive-mode'") &&
      workspaceSource.includes('return isMobileTouchViewport()') &&
      responsiveModeSource.includes('MOBILE_NAVIGATION_MAX_WIDTH = 980') &&
      responsiveModeSource.includes("window.matchMedia('(any-pointer: coarse)').matches") &&
      responsiveModeSource.includes('navigator.maxTouchPoints > 0') &&
      workspaceSource.includes('function isDesktopAutoCollapseWidth(width: number)') &&
      workspaceSource.includes('const syncSidebarForWorkspaceWidth = (width: number) =>') &&
      workspaceSource.includes('if (mobileNavigationViewport) {\n        if (!mobileNavigationViewportRef.current) autoCollapseSidebar()\n        mobileNavigationViewportRef.current = true\n        return\n      }') &&
      workspaceSource.includes('if (sidebarAutoCollapsedRef.current)') &&
      workspaceSource.includes('function AgentRail(') &&
      workspaceSource.includes('data-testid="code-agent-rail-item"') &&
      stylesSource.includes('.code-sidebar.collapsed .code-agent-rail') &&
      stylesSource.includes('grid-auto-rows: 42px;') &&
      stylesSource.includes('width: 42px;\n  height: 42px;\n  flex: 0 0 42px;') &&
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
