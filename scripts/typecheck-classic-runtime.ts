#!/usr/bin/env -S npx tsx

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const projectRoot = path.resolve(__dirname, '..');
const frontendRoot = path.join(projectRoot, 'frontend');

function collectTypeScriptFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'vendor' ? [] : collectTypeScriptFiles(entryPath);
    }
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')
      ? [entryPath]
      : [];
  });
}

const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  module: ts.ModuleKind.None,
  ignoreDeprecations: '6.0',
  noEmit: true,
  strict: true,
  skipLibCheck: true,
};

const diagnostics = collectTypeScriptFiles(frontendRoot)
  .sort()
  .flatMap((filePath) => {
    const program = ts.createProgram({ rootNames: [filePath], options: compilerOptions });
    return ts.getPreEmitDiagnostics(program);
  });

if (diagnostics.length > 0) {
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: fileName => fileName,
    getCurrentDirectory: () => projectRoot,
    getNewLine: () => '\n',
  }));
  process.exit(1);
}
