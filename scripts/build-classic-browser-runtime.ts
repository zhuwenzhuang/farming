#!/usr/bin/env -S npx tsx

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const projectRoot = path.resolve(__dirname, '..');
const frontendRoot = path.join(projectRoot, 'frontend');
const sharedRoot = path.join(projectRoot, 'shared');
const generatedHeader = '// Generated from TypeScript. Do not edit.';

function collectTypeScriptFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectTypeScriptFiles(entryPath);
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')
      ? [entryPath]
      : [];
  });
}

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
  return ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: fileName => fileName,
    getCurrentDirectory: () => projectRoot,
    getNewLine: () => '\n',
  });
}

function transpileRuntime(filePath: string, module: ts.ModuleKind): void {
  const source = fs.readFileSync(filePath, 'utf8');
  const result = ts.transpileModule(source, {
    fileName: filePath,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module,
      newLine: ts.NewLineKind.LineFeed,
      removeComments: false,
      ignoreDeprecations: '6.0',
    },
  });
  const errors = result.diagnostics?.filter(diagnostic => (
    diagnostic.category === ts.DiagnosticCategory.Error
  )) || [];
  if (errors.length > 0) throw new Error(formatDiagnostics(errors));
  fs.writeFileSync(filePath.replace(/\.ts$/, '.js'), `${generatedHeader}\n${result.outputText}`);
}

function main(): void {
  for (const filePath of collectTypeScriptFiles(frontendRoot).sort()) {
    transpileRuntime(filePath, ts.ModuleKind.None);
  }
  for (const filePath of collectTypeScriptFiles(sharedRoot).sort()) {
    transpileRuntime(filePath, ts.ModuleKind.CommonJS);
  }
}

try {
  main();
} catch (error: unknown) {
  console.error(error);
  process.exit(1);
}
