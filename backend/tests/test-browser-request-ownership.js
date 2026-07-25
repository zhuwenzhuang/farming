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
  const agentHomesSource = read('src/components/code/AgentHomesSettingsPanel.tsx');

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
    agentHomesSource.includes('if (!panelScopeRef.current.open || homesSaveRequestRef.current) return')
      && agentHomesSource.includes('settingsLoadRequestRef.current !== requestId')
      && agentHomesSource.includes('panelScopeRef.current.generation !== generation')
      && agentHomesSource.includes('homesSaveRequestRef.current !== requestId')
      && agentHomesSource.includes('disabled={loading || saving}'),
    'Agent Home loads and saves should use synchronous admission and reject results from an old panel generation'
  );

  console.log('✓ Browser requests reject stale results after resource replacement or unmount');
}

run();
