const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ts = require('typescript') as typeof import('typescript');

const { AgentManager } = require('../agent-manager.cjs');
const { AcpRuntimeHostRuntime } = require('../acp-runtime-host-runtime.cjs');
const { ConfigManager } = require('../config-manager.cjs');
const { createTestAcpRuntime } = require('./helpers/test-acp-runtime.ts');

const projectRoot = path.join(__dirname, '..', '..');
const managerSource = fs.readFileSync(path.join(projectRoot, 'backend/agent-manager.cts'), 'utf8');
const sourceFile = ts.createSourceFile(
  'backend/agent-manager.cts',
  managerSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
assert.strictEqual(sourceFile.text, managerSource, 'the dependency boundary must inspect the complete source file');

function importedValues(moduleSpecifier: string): Set<string> {
  const values = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== moduleSpecifier
      || statement.importClause?.isTypeOnly) continue;
    if (statement.importClause?.name) values.add('default');
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) values.add('*');
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (!element.isTypeOnly) values.add(element.propertyName?.text || element.name.text);
      }
    }
  }
  return values;
}

assert(
  importedValues('./acp-runtime-host-runtime.cjs').has('AcpRuntimeHostRuntime'),
  'AgentManager must depend on the ACP Host facade',
);
assert(
  !importedValues('./acp-runtime.cjs').has('AcpRuntime'),
  'the in-process ACP engine must stay behind the Host process boundary',
);

async function run(): Promise<void> {
  assert.throws(
    () => new AgentManager(null),
    error => error instanceof Error,
    'AgentManager must reject an implicit Config instance when no runtime is supplied',
  );

  const explicitRuntime = createTestAcpRuntime();
  const explicitManager = new AgentManager(null, { acpRuntime: explicitRuntime });
  try {
    assert.strictEqual(explicitManager.acpRuntime, explicitRuntime);
  } finally {
    await explicitManager.dispose();
  }

  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-host-boundary-'));
  let managedManager: InstanceType<typeof AgentManager> | null = null;
  try {
    const configManager = new ConfigManager({ configDir });
    configManager.init();
    managedManager = new AgentManager(configManager, { skipExecutablePreflight: true });
    assert(
      managedManager.acpRuntime instanceof AcpRuntimeHostRuntime,
      'an exact Config instance must select the managed ACP Host facade',
    );
  } finally {
    await managedManager?.dispose();
    fs.rmSync(configDir, { recursive: true, force: true });
  }

  console.log('AgentManager ACP Host boundary tests passed');
}

run().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
