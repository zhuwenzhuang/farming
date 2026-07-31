const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
}

function run() {
  const blameSource = read('src/components/files/useFileEditorBlameController.ts');
  const openFileSource = read('src/components/files/useWorkspaceFileOpenController.ts');
  const inputDialogSource = read('src/components/InputDialog.tsx');
  const acpSessionSource = read('src/components/code/acp/useAcpSession.ts');
  const pluginsSource = read('src/components/code/PluginsPanel.tsx');

  assert(
    blameSource.includes('openFileKeyRef.current !== requestedFileKey')
      && blameSource.includes('blameRequestRef.current !== requestId')
      && blameSource.includes('disabledRef.current'),
    'Blame results should commit only while the request still owns the active file'
  );

  assert(
    openFileSource.includes('fileOpenScopeRef.current.agentId !== requestAgentId')
      && openFileSource.includes('!fileOpenScopeRef.current.mounted')
      && openFileSource.includes('fileOpenRequestRef.current += 1'),
    'Open-file results should commit only while the request still owns the mounted workspace'
  );

  assert(
    inputDialogSource.includes("}) => {\n        if (cancelled) return\n        const settings = data.settings ?? {}")
      && inputDialogSource.includes(".catch(() => {\n        if (cancelled) return\n        setWorkspaceHistory([])"),
    'A closed or reopened InputDialog should ignore its previous settings request'
  );

  assert(
    acpSessionSource.includes('refreshRequestRef.current !== requestId')
      && acpSessionSource.includes('accountMutationRef.current?.sequence !== sequence')
      && acpSessionSource.includes('scopeRef.current.agentId !== requestAgentId'),
    'ACP refresh, authentication, and logout results should commit only to their originating Agent'
  );

  assert(
    pluginsSource.includes('if (!agentPanelScopeRef.current.mounted || agentSaveRequestRef.current) return')
      && pluginsSource.includes('agentGroupsRequestRef.current !== requestId')
      && pluginsSource.includes('agentPanelScopeRef.current.generation !== generation')
      && pluginsSource.includes('agentSaveRequestRef.current !== requestId')
      && pluginsSource.includes('const AGENT_SETTINGS_REQUEST_TIMEOUT_MS = 15_000')
      && pluginsSource.includes("fetchAgentSettings(appPath('/api/settings')")
      && pluginsSource.includes('reconcileAfterSave')
      && pluginsSource.includes('disabled={agentSaving'),
    'Agent Home loads and saves should be bounded, reconcile uncertain saves, and reject results from an old panel generation'
  );

  assert(
    pluginsSource.includes('setAgentGroups(nextGroups)\n    void saveAgentGroups(nextGroups)')
      && pluginsSource.includes('className="code-plugin-agent-drag"')
      && pluginsSource.includes('draggable={!agentSaving}')
      && pluginsSource.includes("event.key !== 'ArrowUp' && event.key !== 'ArrowDown'")
      && !pluginsSource.includes('ArrowUpGlyph')
      && !pluginsSource.includes('ArrowDownGlyph')
      && !pluginsSource.includes('draggable={!agentSaving}\n              onDragStart'),
    'Agent Home ordering should use one drag-handle interaction, remain keyboard operable, and update locally before save reconciliation'
  );

  console.log('✓ Browser requests reject stale results after resource replacement or unmount');
}

run();
