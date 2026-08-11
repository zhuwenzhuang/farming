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
const productionRoots = new Set(['backend', 'desktop', 'extensions', 'frontend', 'scripts', 'shared', 'src']);
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

function discoverTestFiles(): string[] {
  const files: string[] = [];
  for (const root of testRoots) {
    const absoluteRoot = path.join(projectRoot, root);
    for (const entry of fs.readdirSync(absoluteRoot, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/^(?:test-.*|.*\.test)\.ts$/.test(entry.name)) continue;
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

function inspectedTarget(node: ts.CallExpression, allowBarePackage = false): string | null {
  const argument = node.arguments[0];
  if (!argument) return null;
  const fragments = stringFragments(argument);
  const root = fragments
    .flatMap(fragment => fragment.split(/[\\/]/))
    .find(fragment => productionRoots.has(fragment));
  if (root) return root;
  if (fragments.some(fragment => fragment.endsWith('package.json'))
    && (allowBarePackage || hasRepositoryAnchor(argument) || hasRequireResolve(argument))) return 'package.json';
  return null;
}

export function inspectSourceText(relativePath: string, sourceText: string): Inspection[] {
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
        const target = inspectedTarget(node, name !== null && sourceReaders.has(name))
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

function inspectionsInFile(relativePath: string): Inspection[] {
  return inspectSourceText(relativePath, fs.readFileSync(path.join(projectRoot, relativePath), 'utf8'));
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
