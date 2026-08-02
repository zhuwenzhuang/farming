import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';

const repoRoot = path.join(__dirname, '..', '..');
const sourceRoot = path.join(repoRoot, 'src');
const runtimePathOwner = path.join(sourceRoot, 'lib', 'base-path.ts');

function browserSourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) return browserSourceFiles(candidate);
      return /\.tsx?$/.test(entry.name) ? [candidate] : [];
    })
    .sort();
}

function literalRouteStart(node: ts.Expression | undefined): string {
  if (!node) return '';
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text;
  return '';
}

function isSameOriginLiteral(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//');
}

function run() {
  const duplicateRuntimeOwners: string[] = [];
  const directSameOriginRoutes: string[] = [];

  for (const filePath of browserSourceFiles(sourceRoot)) {
    const source = fs.readFileSync(filePath, 'utf8');
    const relativePath = path.relative(repoRoot, filePath);
    if (filePath !== runtimePathOwner && (
      source.includes('__FARMING_BASE_PATH__')
      || /import\.meta\.env\??\.BASE_URL/.test(source)
    )) {
      duplicateRuntimeOwners.push(relativePath);
    }

    const sourceFile = ts.createSourceFile(
      filePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const inspect = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const target = node.expression.getText(sourceFile);
        if ([
          'fetch',
          'window.fetch',
          'window.open',
          'location.assign',
          'location.replace',
          'window.location.assign',
          'window.location.replace',
        ].includes(target)) {
          const route = literalRouteStart(node.arguments[0]);
          if (isSameOriginLiteral(route)) {
            directSameOriginRoutes.push(`${relativePath}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
          }
        }
      } else if (ts.isNewExpression(node)) {
        const target = node.expression.getText(sourceFile);
        if (['WebSocket', 'EventSource'].includes(target)) {
          const route = literalRouteStart(node.arguments?.[0]);
          if (isSameOriginLiteral(route)) {
            directSameOriginRoutes.push(`${relativePath}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
          }
        }
      } else if (
        ts.isJsxAttribute(node)
        && ['src', 'href'].includes(node.name.getText(sourceFile))
        && node.initializer
        && ts.isStringLiteral(node.initializer)
        && isSameOriginLiteral(node.initializer.text)
      ) {
        directSameOriginRoutes.push(`${relativePath}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
      }
      ts.forEachChild(node, inspect);
    };
    inspect(sourceFile);
  }

  assert.deepStrictEqual(
    duplicateRuntimeOwners,
    [],
    'src/lib/base-path.ts must remain the only React runtime/build base-path reader',
  );
  assert.deepStrictEqual(
    directSameOriginRoutes,
    [],
    'same-origin browser routes must be resolved through appPath/appWsUrl instead of root literals',
  );

  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  assert(
    packageJson.scripts?.start?.startsWith('FARMING_BASE_PATH=${FARMING_BASE_PATH:-/farming} npm run build'),
    'npm start must build with the same default base path used by farming start',
  );
  const startNewUi = fs.readFileSync(path.join(repoRoot, 'scripts', 'start-new-ui.sh'), 'utf8');
  assert(
    startNewUi.includes('export FARMING_BASE_PATH="${FARMING_BASE_PATH:-/farming}"')
    && startNewUi.indexOf('export FARMING_BASE_PATH=') < startNewUi.indexOf('npm run build'),
    'source UI launchers must establish the Server base path before building browser assets',
  );

  console.log('✓ React routes have one runtime base-path owner and startup keeps build/runtime defaults aligned');
}

run();
