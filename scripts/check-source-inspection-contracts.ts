#!/usr/bin/env -S node --import tsx
/**
 * Keeps implementation-text inspection out of behavior tests.
 *
 * A test which reads product source is an architecture/package/generated/security
 * contract, never evidence that a user-visible behavior works.  Existing static
 * contracts are listed in tests/source-inspection-allowlist.json with an exact
 * baseline count so that this debt can only decrease without an intentional,
 * reviewed allowlist change.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const projectRoot = path.join(__dirname, '..');
const allowlistPath = path.join(projectRoot, 'tests', 'source-inspection-allowlist.json');
const testRoots = ['tests', 'backend/tests'];
const productionRoots = new Set(['backend', 'bin', 'desktop', 'extensions', 'frontend', 'scripts', 'shared', 'src']);
const rootProductionFiles = new Set(['index.html', 'package.json', 'pkg.config.cjs', 'vite.config.ts']);
const allowedCategories = new Set(['architecture', 'generated', 'package', 'security']);

interface AllowlistEntry {
  file: string;
  category: string;
  reason: string;
  owner: string;
  baselineCount: number;
}

interface Allowlist {
  version: number;
  allowlist: AllowlistEntry[];
  legacyDebt: Array<Omit<AllowlistEntry, 'category'>>;
}

interface Inspection {
  file: string;
  line: number;
  target: string;
}

type HelperSummaries = ReadonlyMap<string, readonly string[]>;
type LocalModuleReader = (relativePath: string) => string | null;

function isTestSupportModule(relativePath: string): boolean {
  const normalized = relativePath.replaceAll('\\', '/');
  return testRoots.some(root => normalized.startsWith(`${root}/`));
}

export function discoverTestFiles(): string[] {
  const files: string[] = [];
  for (const root of testRoots) {
    const absoluteRoot = path.join(projectRoot, root);
    for (const entry of fs.readdirSync(absoluteRoot, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/^(?:test-.*|.*\.(?:test|spec))\.ts$/.test(entry.name)) continue;
      const absolute = path.join(entry.parentPath, entry.name);
      files.push(path.relative(projectRoot, absolute));
    }
  }
  return files.sort();
}

function calleeName(node: ts.CallExpression): string | null {
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (!ts.isPropertyAccessExpression(node.expression)) return null;
  return node.expression.name.text;
}

function expressionReference(node: ts.Expression): string | null {
  if (ts.isIdentifier(node)) return node.text;
  if (!ts.isPropertyAccessExpression(node)) return null;
  const owner = expressionReference(node.expression);
  return owner ? `${owner}.${node.name.text}` : null;
}

function isReadCall(node: ts.CallExpression): boolean {
  const name = calleeName(node);
  return name === 'readFile' || name === 'readFileSync';
}

function stringFragments(node: ts.Expression): string[] {
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return [...stringFragments(node.left), ...stringFragments(node.right)];
  }
  if (ts.isCallExpression(node)) return node.arguments.flatMap(argument => stringFragments(argument));
  if (ts.isParenthesizedExpression(node)) return stringFragments(node.expression);
  return [];
}

function hasRepositoryAnchor(node: ts.Node): boolean {
  if (ts.isIdentifier(node) && ['__dirname', 'projectRoot', 'repoRoot'].includes(node.text)) return true;
  let found = false;
  ts.forEachChild(node, child => {
    if (!found && hasRepositoryAnchor(child)) found = true;
  });
  return found;
}

function hasRequireResolve(node: ts.Node): boolean {
  if (ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === 'require'
    && node.expression.name.text === 'resolve') return true;
  let found = false;
  ts.forEachChild(node, child => {
    if (!found && hasRequireResolve(child)) found = true;
  });
  return found;
}

function repositoryPathFromExpression(relativePath: string, node: ts.Expression): string | null {
  if (ts.isIdentifier(node)) {
    if (node.text === '__dirname') return path.dirname(relativePath);
    if (node.text === 'projectRoot' || node.text === 'repoRoot') return '.';
    return null;
  }
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return repositoryPathFromExpression(relativePath, node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = repositoryPathFromExpression(relativePath, node.left);
    const right = repositoryPathFromExpression(relativePath, node.right);
    return left !== null && right !== null ? `${left}${right}` : null;
  }
  if (!ts.isCallExpression(node)
    || !ts.isPropertyAccessExpression(node.expression)
    || !ts.isIdentifier(node.expression.expression)
    || node.expression.expression.text !== 'path'
    || !['join', 'resolve'].includes(node.expression.name.text)) return null;
  const parts = node.arguments.map(argument => repositoryPathFromExpression(relativePath, argument));
  if (parts.some(part => part === null) || parts.length === 0) return null;
  return path.normalize(path.join(...parts as string[]));
}

function targetFromRepositoryPath(repositoryPath: string | null): string | null {
  if (!repositoryPath) return null;
  const normalized = path.normalize(repositoryPath);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`) || path.isAbsolute(normalized)) return null;
  const [root] = normalized.split(/[\\/]/);
  if (root && productionRoots.has(root)) return root;
  return rootProductionFiles.has(normalized) ? normalized : null;
}

function inspectedTarget(relativePath: string, node: ts.CallExpression, allowBarePackage = false): string | null {
  const argument = node.arguments[0];
  if (!argument) return null;
  const repositoryTarget = targetFromRepositoryPath(repositoryPathFromExpression(relativePath, argument));
  if (repositoryTarget) return repositoryTarget;
  const fragments = stringFragments(argument);
  const root = fragments
    .flatMap(fragment => fragment.split(/[\\/]/))
    .find(fragment => productionRoots.has(fragment));
  if (root) return root;
  if (fragments.some(fragment => fragment.endsWith('package.json'))
    && (allowBarePackage || hasRepositoryAnchor(argument) || hasRequireResolve(argument))) return 'package.json';
  return null;
}

export function inspectSourceText(
  relativePath: string,
  sourceText: string,
  helperSummaries: HelperSummaries = new Map(),
): Inspection[] {
  const sourceFile = ts.createSourceFile(relativePath, sourceText, ts.ScriptTarget.ES2023, true);
  const sourceReaders = new Set<string>();
  const readerDefaultTargets = new Map<string, string>();
  const tainted = new Map<string, Inspection[]>();

  const inspectionAt = (node: ts.Node, target: string): Inspection => ({
    file: relativePath,
    line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
    target,
  });
  const unique = (records: Inspection[]): Inspection[] => {
    const seen = new Set<string>();
    return records.filter(record => {
      const key = `${record.file}:${record.line}:${record.target}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const containsReadCall = (node: ts.Node): boolean => {
    let found = false;
    const visit = (descendant: ts.Node): void => {
      if (ts.isCallExpression(descendant) && isReadCall(descendant)) found = true;
      if (!found) ts.forEachChild(descendant, visit);
    };
    visit(node);
    return found;
  };
  const collectSourceReaders = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body && containsReadCall(node.body)) {
      sourceReaders.add(node.name.text);
    }
    if (ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      && containsReadCall(node.initializer)) {
      sourceReaders.add(node.name.text);
    }
    if (ts.isImportDeclaration(node)
      && ts.isStringLiteral(node.moduleSpecifier)
      && /source-reader/.test(node.moduleSpecifier.text)
      && node.importClause?.namedBindings
      && ts.isNamedImports(node.importClause.namedBindings)) {
      for (const element of node.importClause.namedBindings.elements) {
        sourceReaders.add(element.name.text);
        readerDefaultTargets.set(element.name.text, 'src');
      }
    }
    if (ts.isVariableDeclaration(node)
      && ts.isObjectBindingPattern(node.name)
      && node.initializer
      && ts.isCallExpression(node.initializer)
      && ts.isIdentifier(node.initializer.expression)
      && node.initializer.expression.text === 'require'
      && node.initializer.arguments.some(argument => ts.isStringLiteral(argument) && /source-reader/.test(argument.text))) {
      for (const element of node.name.elements) {
        if (!ts.isIdentifier(element.name)) continue;
        sourceReaders.add(element.name.text);
        readerDefaultTargets.set(element.name.text, 'src');
      }
    }
    ts.forEachChild(node, collectSourceReaders);
  };
  collectSourceReaders(sourceFile);

  const readerName = (node: ts.Expression): string | null => {
    if (ts.isIdentifier(node)) return node.text;
    return null;
  };
  const targetFromPathExpression = (node: ts.Expression): string | null => {
    const repositoryTarget = targetFromRepositoryPath(repositoryPathFromExpression(relativePath, node));
    if (repositoryTarget) return repositoryTarget;
    const fragments = stringFragments(node);
    const root = fragments.flatMap(fragment => fragment.split(/[\\/]/)).find(fragment => productionRoots.has(fragment));
    if (root) return root;
    return fragments.some(fragment => fragment.endsWith('package.json')) ? 'package.json' : null;
  };
  const taintFromExpression = (node: ts.Expression): Inspection[] => {
    if (ts.isIdentifier(node)) return tainted.get(node.text) || [];
    if (ts.isParenthesizedExpression(node)) return taintFromExpression(node.expression);
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (isReadCall(node) || (name !== null && sourceReaders.has(name))) {
        const target = inspectedTarget(relativePath, node, name !== null && sourceReaders.has(name))
          || (name === null ? null : readerDefaultTargets.get(name))
          || null;
        return target ? [inspectionAt(node, target)] : [];
      }
      if (ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'map'
        && node.arguments[0]
        && readerName(node.arguments[0])
        && sourceReaders.has(readerName(node.arguments[0]) as string)) {
        const paths = ts.isArrayLiteralExpression(node.expression.expression)
          ? node.expression.expression.elements
          : [];
        return paths.flatMap(pathNode => {
          const target = targetFromPathExpression(pathNode as ts.Expression);
          return target ? [inspectionAt(pathNode, target)] : [];
        });
      }
      const receiverTaint = ts.isPropertyAccessExpression(node.expression)
        ? taintFromExpression(node.expression.expression)
        : [];
      return unique([...receiverTaint, ...node.arguments.flatMap(argument => taintFromExpression(argument))]);
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      return taintFromExpression(node.expression);
    }
    if (ts.isArrayLiteralExpression(node)) {
      return unique(node.elements.flatMap(element => taintFromExpression(element as ts.Expression)));
    }
    if (ts.isConditionalExpression(node)) {
      return unique([...taintFromExpression(node.whenTrue), ...taintFromExpression(node.whenFalse)]);
    }
    if (ts.isBinaryExpression(node)) {
      return unique([...taintFromExpression(node.left), ...taintFromExpression(node.right)]);
    }
    return [];
  };

  const assignments: Array<{ name: string; expression: ts.Expression }> = [];
  const collectAssignments = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      assignments.push({ name: node.name.text, expression: node.initializer });
    }
    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(node.left)) {
      assignments.push({ name: node.left.text, expression: node.right });
    }
    ts.forEachChild(node, collectAssignments);
  };
  collectAssignments(sourceFile);
  for (let pass = 0; pass <= assignments.length; pass += 1) {
    let changed = false;
    for (const assignment of assignments) {
      const next = unique([...(tainted.get(assignment.name) || []), ...taintFromExpression(assignment.expression)]);
      if (next.length !== (tainted.get(assignment.name)?.length || 0)) {
        tainted.set(assignment.name, next);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const assertedInspections: Inspection[] = [];
  const stringMethods = new Set(['includes', 'indexOf', 'startsWith', 'endsWith', 'match', 'search']);
  const assertionComparators = new Set(['equal', 'strictEqual', 'notEqual', 'notStrictEqual']);
  const collectAssertions = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const reference = expressionReference(node.expression);
      for (const target of reference ? helperSummaries.get(reference) || [] : []) {
        assertedInspections.push(inspectionAt(node, target));
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (stringMethods.has(method)) {
        assertedInspections.push(...taintFromExpression(node.expression.expression));
        if ((method === 'match' || method === 'doesNotMatch') && node.arguments[0]) {
          assertedInspections.push(...taintFromExpression(node.arguments[0]));
        }
      }
      if (method === 'doesNotMatch' && node.arguments[0]) {
        assertedInspections.push(...taintFromExpression(node.arguments[0]));
      }
      if (method === 'test' && node.arguments[0]) {
        assertedInspections.push(...taintFromExpression(node.expression.expression));
        assertedInspections.push(...taintFromExpression(node.arguments[0]));
      }
      if (assertionComparators.has(method)) {
        assertedInspections.push(...node.arguments.flatMap(argument => taintFromExpression(argument)));
      }
    }
    if (ts.isBinaryExpression(node)
      && [
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ].includes(node.operatorToken.kind)) {
      assertedInspections.push(...taintFromExpression(node.left), ...taintFromExpression(node.right));
    }
    ts.forEachChild(node, collectAssertions);
  };
  collectAssertions(sourceFile);
  return unique(assertedInspections);
}

function localHelperSummaries(
  relativePath: string,
  sourceText: string,
  readLocalModule: LocalModuleReader,
  cache: Map<string, Map<string, string[]>>,
  visiting: Set<string>,
): Map<string, string[]> {
  const sourceFile = ts.createSourceFile(relativePath, sourceText, ts.ScriptTarget.ES2023, true);
  const summaries = new Map<string, string[]>();
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)
      && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.importClause?.namedBindings
      && ts.isNamedImports(statement.importClause.namedBindings)) {
      const helper = resolveLocalModule(relativePath, statement.moduleSpecifier.text, readLocalModule);
      if (!helper || !isTestSupportModule(helper.path)) continue;
      const helperSummaries = exportedHelperSummaries(helper.path, helper.source, readLocalModule, cache, visiting);
      for (const element of statement.importClause.namedBindings.elements) {
        const importedName = element.propertyName?.text || element.name.text;
        const targets = helperSummaries.get(importedName);
        if (targets) summaries.set(element.name.text, targets);
      }
    }
  }
  const collectCommonJsImports = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      const requireCall = node.initializer && ts.isCallExpression(node.initializer)
        ? node.initializer
        : node.initializer
          && ts.isPropertyAccessExpression(node.initializer)
          && ts.isCallExpression(node.initializer.expression)
          ? node.initializer.expression
          : null;
      if (requireCall
        && ts.isIdentifier(requireCall.expression)
        && requireCall.expression.text === 'require'
        && requireCall.arguments.length === 1
        && ts.isStringLiteral(requireCall.arguments[0])) {
        const helper = resolveLocalModule(relativePath, requireCall.arguments[0].text, readLocalModule);
        if (helper && isTestSupportModule(helper.path)) {
          const helperSummaries = exportedHelperSummaries(helper.path, helper.source, readLocalModule, cache, visiting);
          if (ts.isObjectBindingPattern(node.name)) {
            for (const element of node.name.elements) {
              if (!ts.isIdentifier(element.name)) continue;
              const importedName = element.propertyName && ts.isIdentifier(element.propertyName)
                ? element.propertyName.text
                : element.name.text;
              const targets = helperSummaries.get(importedName);
              if (targets) summaries.set(element.name.text, targets);
            }
          } else if (ts.isIdentifier(node.name)
            && node.initializer
            && ts.isPropertyAccessExpression(node.initializer)) {
            const targets = helperSummaries.get(node.initializer.name.text);
            if (targets) summaries.set(node.name.text, targets);
          } else if (ts.isIdentifier(node.name)) {
            for (const [exportedName, targets] of helperSummaries) {
              summaries.set(`${node.name.text}.${exportedName}`, targets);
            }
            const defaultTargets = helperSummaries.get('default');
            if (defaultTargets) summaries.set(node.name.text, defaultTargets);
          }
        }
      }
    }
    ts.forEachChild(node, collectCommonJsImports);
  };
  collectCommonJsImports(sourceFile);
  return summaries;
}

interface CallableDefinition {
  body: ts.ConciseBody;
  name: string;
  node: ts.Node;
}

function topLevelCallableDefinitions(sourceFile: ts.SourceFile): Map<string, CallableDefinition> {
  const definitions = new Map<string, CallableDefinition>();
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      definitions.set(statement.name.text, { body: statement.body, name: statement.name.text, node: statement });
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)
        || !declaration.initializer
        || (!ts.isArrowFunction(declaration.initializer) && !ts.isFunctionExpression(declaration.initializer))) continue;
      definitions.set(declaration.name.text, {
        body: declaration.initializer.body,
        name: declaration.name.text,
        node: declaration,
      });
    }
  }
  return definitions;
}

function exportedCallableNames(
  sourceFile: ts.SourceFile,
  definitions: ReadonlyMap<string, CallableDefinition>,
): Map<string, string> {
  const exports = new Map<string, string>();
  const isExported = (node: ts.Node & { modifiers?: ts.NodeArray<ts.ModifierLike> }): boolean => (
    node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) || false
  );
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && isExported(statement)) {
      exports.set(statement.name.text, statement.name.text);
      continue;
    }
    if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && definitions.has(declaration.name.text)) {
          exports.set(declaration.name.text, declaration.name.text);
        }
      }
      continue;
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        const localName = element.propertyName?.text || element.name.text;
        if (definitions.has(localName)) exports.set(element.name.text, localName);
      }
      continue;
    }
    if (!ts.isExpressionStatement(statement)
      || !ts.isBinaryExpression(statement.expression)
      || statement.expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
    const { left, right } = statement.expression;
    if (ts.isPropertyAccessExpression(left)
      && ts.isIdentifier(left.expression)
      && left.expression.text === 'exports'
      && ts.isIdentifier(right)
      && definitions.has(right.text)) {
      exports.set(left.name.text, right.text);
      continue;
    }
    if (ts.isPropertyAccessExpression(left)
      && ts.isPropertyAccessExpression(left.expression)
      && ts.isIdentifier(left.expression.expression)
      && left.expression.expression.text === 'module'
      && left.expression.name.text === 'exports'
      && ts.isIdentifier(right)
      && definitions.has(right.text)) {
      exports.set(left.name.text, right.text);
      continue;
    }
    if (!ts.isPropertyAccessExpression(left)
      || !ts.isIdentifier(left.expression)
      || left.expression.text !== 'module'
      || left.name.text !== 'exports') continue;
    if (ts.isIdentifier(right) && definitions.has(right.text)) {
      exports.set('default', right.text);
    } else if (ts.isObjectLiteralExpression(right)) {
      for (const property of right.properties) {
        if (ts.isShorthandPropertyAssignment(property) && definitions.has(property.name.text)) {
          exports.set(property.name.text, property.name.text);
        } else if (ts.isPropertyAssignment(property)
          && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))
          && ts.isIdentifier(property.initializer)
          && definitions.has(property.initializer.text)) {
          exports.set(property.name.text, property.initializer.text);
        }
      }
    }
  }
  return exports;
}

function exportedHelperSummaries(
  relativePath: string,
  sourceText: string,
  readLocalModule: LocalModuleReader,
  cache: Map<string, Map<string, string[]>>,
  visiting: Set<string>,
): Map<string, string[]> {
  const cached = cache.get(relativePath);
  if (cached) return cached;
  if (visiting.has(relativePath)) return new Map();
  visiting.add(relativePath);
  const sourceFile = ts.createSourceFile(relativePath, sourceText, ts.ScriptTarget.ES2023, true);
  const importedSummaries = localHelperSummaries(relativePath, sourceText, readLocalModule, cache, visiting);
  const inspections = inspectSourceText(relativePath, sourceText, importedSummaries);
  const summaries = new Map<string, string[]>();
  const definitions = topLevelCallableDefinitions(sourceFile);
  const targetsByCallable = new Map<string, Set<string>>();
  const callsByCallable = new Map<string, Set<string>>();
  for (const definition of definitions.values()) {
    const startLine = sourceFile.getLineAndCharacterOfPosition(definition.node.getStart(sourceFile)).line + 1;
    const endLine = sourceFile.getLineAndCharacterOfPosition(definition.node.getEnd()).line + 1;
    targetsByCallable.set(definition.name, new Set(
      inspections
        .filter(inspection => inspection.line >= startLine && inspection.line <= endLine)
        .map(inspection => inspection.target),
    ));
    const calls = new Set<string>();
    const visitCalls = (node: ts.Node): void => {
      if (node !== definition.body && ts.isFunctionLike(node)) return;
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && definitions.has(node.expression.text)) {
        calls.add(node.expression.text);
      }
      ts.forEachChild(node, visitCalls);
    };
    visitCalls(definition.body);
    callsByCallable.set(definition.name, calls);
  }
  for (let pass = 0; pass <= definitions.size; pass += 1) {
    let changed = false;
    for (const [name, calls] of callsByCallable) {
      const targets = targetsByCallable.get(name) as Set<string>;
      for (const called of calls) {
        for (const target of targetsByCallable.get(called) || []) {
          if (targets.has(target)) continue;
          targets.add(target);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  for (const [exportedName, localName] of exportedCallableNames(sourceFile, definitions)) {
    const targets = [...(targetsByCallable.get(localName) || [])];
    if (targets.length > 0) summaries.set(exportedName, targets);
  }
  visiting.delete(relativePath);
  cache.set(relativePath, summaries);
  return summaries;
}

function resolveLocalModule(
  fromRelativePath: string,
  specifier: string,
  readLocalModule: LocalModuleReader,
): { path: string; source: string } | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.normalize(path.join(path.dirname(fromRelativePath), specifier));
  const sourceBase = base.replace(/\.cjs$/, '.cts').replace(/\.js$/, '.ts');
  for (const candidate of [
    base,
    sourceBase,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.cts`,
    `${base}.js`,
    path.join(base, 'index.ts'),
  ]) {
    const source = readLocalModule(candidate);
    if (source !== null) return { path: candidate, source };
  }
  return null;
}

export function inspectSourceTextWithLocalHelpers(
  relativePath: string,
  sourceText: string,
  readLocalModule: LocalModuleReader,
): Inspection[] {
  const summaries = localHelperSummaries(relativePath, sourceText, readLocalModule, new Map(), new Set());
  return inspectSourceText(relativePath, sourceText, summaries);
}

function inspectionsInFile(relativePath: string): Inspection[] {
  const sourceText = fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
  return inspectSourceTextWithLocalHelpers(relativePath, sourceText, candidate => {
    const absolutePath = path.join(projectRoot, candidate);
    return fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()
      ? fs.readFileSync(absolutePath, 'utf8')
      : null;
  });
}

function readAllowlist(): Allowlist {
  return JSON.parse(fs.readFileSync(allowlistPath, 'utf8')) as Allowlist;
}

function main(): void {
  const inspections = discoverTestFiles().flatMap(inspectionsInFile);
  if (process.argv.includes('--report')) {
    for (const inspection of inspections) console.log(`${inspection.file}:${inspection.line} (${inspection.target})`);
    console.log(`Total source inspections: ${inspections.length}`);
    return;
  }

  const allowlist = readAllowlist();
  const failures: string[] = [];
  if (allowlist.version !== 1) failures.push(`unsupported allowlist version: ${allowlist.version}`);
  const entries = new Map<string, AllowlistEntry>();
  for (const entry of allowlist.allowlist) {
    if (entries.has(entry.file)) failures.push(`duplicate allowlist entry: ${entry.file}`);
    entries.set(entry.file, entry);
    if (!allowedCategories.has(entry.category)) failures.push(`${entry.file} has invalid category: ${entry.category}`);
    if (!entry.reason?.trim()) failures.push(`${entry.file} must state why source inspection is necessary`);
    if (!entry.owner?.trim()) failures.push(`${entry.file} must name an owner`);
    if (!Number.isInteger(entry.baselineCount) || entry.baselineCount < 1) {
      failures.push(`${entry.file} must have a positive integer baselineCount`);
    }
  }
  for (const entry of allowlist.legacyDebt) {
    if (entries.has(entry.file)) failures.push(`duplicate source-inspection registration: ${entry.file}`);
    entries.set(entry.file, { ...entry, category: 'legacy' });
    if (!entry.reason?.trim()) failures.push(`${entry.file} must state why the legacy source inspection remains`);
    if (!entry.owner?.trim()) failures.push(`${entry.file} must name an owner`);
    if (!Number.isInteger(entry.baselineCount) || entry.baselineCount < 1) {
      failures.push(`${entry.file} must have a positive integer baselineCount`);
    }
  }

  const byFile = new Map<string, Inspection[]>();
  for (const inspection of inspections) {
    const records = byFile.get(inspection.file) || [];
    records.push(inspection);
    byFile.set(inspection.file, records);
  }
  for (const [file, records] of byFile) {
    const entry = entries.get(file);
    if (!entry) {
      failures.push(`${file} has ${records.length} unregistered product-source inspection(s): ${records.map(record => `${record.target}:${record.line}`).join(', ')}`);
      continue;
    }
    if (entry.baselineCount !== records.length) {
      failures.push(`${file} inspected ${records.length} product source file(s), but its baselineCount is ${entry.baselineCount}; lower the baseline when removing debt and require review for any increase`);
    }
  }
  for (const entry of entries.values()) {
    if (!byFile.has(entry.file)) failures.push(`${entry.file} is allowlisted but no longer inspects product source; remove its entry`);
  }

  if (failures.length > 0) {
    console.error('Source-inspection contract validation failed:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log(`Source-inspection contracts valid: ${inspections.length} inspections in ${byFile.size} files`);
}

if (require.main === module) main();
