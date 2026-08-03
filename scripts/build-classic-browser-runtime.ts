#!/usr/bin/env -S npx tsx

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { PROTOCOL_VERSION } from '../shared/browser-protocol';

const projectRoot = path.resolve(__dirname, '..');
const frontendRoot = path.join(projectRoot, 'frontend');
const sharedRoot = path.join(projectRoot, 'shared');
const generatedHeader = '// Generated from TypeScript. Do not edit.';
const crtAppPath = path.join(frontendRoot, 'skins', 'crt', 'app.ts');
const browserProtocolVersionMarker = "Number('__FARMING_BROWSER_PROTOCOL_VERSION__')";

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
  let outputText = result.outputText;
  if (filePath === crtAppPath) {
    if (!outputText.includes(browserProtocolVersionMarker)) {
      throw new Error('CRT browser protocol version marker is missing');
    }
    outputText = outputText.replace(browserProtocolVersionMarker, String(PROTOCOL_VERSION));
  }
  fs.writeFileSync(filePath.replace(/\.ts$/, '.js'), `${generatedHeader}\n${outputText}`);
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
