const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript') as typeof import('typescript');

const HTTP_METHODS = new Set(['delete', 'get', 'patch', 'post', 'put']);

interface RouteRegistration {
  detail?: string;
  guard?: string;
  method: string;
  path: string;
  position: number;
}

interface ImportedSymbol {
  importedName: string;
  moduleSpecifier: string;
}

interface RouterFactoryDefinition {
  factoryName: string;
  filePath: string;
}

const OPAQUE_API_MOUNTS = new Set<string>();

function sourceFile(filePath: string): import('typescript').SourceFile {
  return ts.createSourceFile(
    filePath,
    fs.readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function literalPaths(expression: import('typescript').Expression): string[] {
  if (ts.isStringLiteralLike(expression)) return [expression.text];
  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.flatMap(element => (
      ts.isSpreadElement(element) ? [] : literalPaths(element as import('typescript').Expression)
    ));
  }
  if (
    ts.isCallExpression(expression)
    && ts.isIdentifier(expression.expression)
    && expression.expression.text === 'routePath'
    && expression.arguments[1]
  ) {
    return literalPaths(expression.arguments[1]);
  }
  return [];
}

function isFunctionLike(node: import('typescript').Node): boolean {
  return ts.isArrowFunction(node)
    || ts.isConstructorDeclaration(node)
    || ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isMethodDeclaration(node)
    || ts.isSetAccessorDeclaration(node);
}

function importedSymbols(
  parsed: import('typescript').SourceFile,
): Map<string, ImportedSymbol> {
  const result = new Map<string, ImportedSymbol>();
  for (const statement of parsed.statements) {
    if (
      !ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || !statement.importClause?.namedBindings
      || !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }
    for (const element of statement.importClause.namedBindings.elements) {
      result.set(element.name.text, {
        importedName: element.propertyName?.text || element.name.text,
        moduleSpecifier: statement.moduleSpecifier.text,
      });
    }
  }
  return result;
}

function resolveTypeScriptSource(fromFile: string, moduleSpecifier: string): string | null {
  if (!moduleSpecifier.startsWith('.')) return null;
  const importedPath = path.resolve(path.dirname(fromFile), moduleSpecifier);
  const candidates = [
    importedPath.replace(/\.cjs$/, '.cts'),
    importedPath.replace(/\.js$/, '.ts'),
    importedPath,
  ];
  return candidates.find(candidate => (
    fs.existsSync(candidate) && fs.statSync(candidate).isFile()
  )) || null;
}

function functionDeclaration(
  parsed: import('typescript').SourceFile,
  name: string,
): import('typescript').FunctionDeclaration | null {
  const declaration = parsed.statements.find(statement => (
    ts.isFunctionDeclaration(statement) && statement.name?.text === name
  ));
  return declaration && ts.isFunctionDeclaration(declaration) ? declaration : null;
}

function resolveRouterFactoryDefinition(
  filePath: string,
  exportedName: string,
  visited = new Set<string>(),
): RouterFactoryDefinition | null {
  const visitKey = `${filePath}:${exportedName}`;
  if (visited.has(visitKey)) return null;
  visited.add(visitKey);

  const parsed = sourceFile(filePath);
  if (functionDeclaration(parsed, exportedName)) {
    return { factoryName: exportedName, filePath };
  }

  const imports = importedSymbols(parsed);
  for (const statement of parsed.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
      continue;
    }
    for (const element of statement.exportClause.elements) {
      if (element.name.text !== exportedName) continue;
      const localName = element.propertyName?.text || element.name.text;
      if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        const reexportSource = resolveTypeScriptSource(filePath, statement.moduleSpecifier.text);
        return reexportSource
          ? resolveRouterFactoryDefinition(reexportSource, localName, visited)
          : null;
      }
      if (functionDeclaration(parsed, localName)) {
        return { factoryName: localName, filePath };
      }
      const imported = imports.get(localName);
      if (!imported) return null;
      const importedSource = resolveTypeScriptSource(filePath, imported.moduleSpecifier);
      return importedSource
        ? resolveRouterFactoryDefinition(importedSource, imported.importedName, visited)
        : null;
    }
  }
  return null;
}

function objectLiteralDescription(
  expression: import('typescript').Expression,
): string | null {
  if (!ts.isObjectLiteralExpression(expression)) return null;
  const properties: string[] = [];
  for (const property of expression.properties) {
    if (!ts.isPropertyAssignment(property)) return null;
    const name = ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)
      ? property.name.text
      : '';
    const value = ts.isStringLiteralLike(property.initializer) || ts.isNumericLiteral(property.initializer)
      ? property.initializer.text
      : property.initializer.kind === ts.SyntaxKind.TrueKeyword
        ? 'true'
        : property.initializer.kind === ts.SyntaxKind.FalseKeyword
          ? 'false'
          : '';
    if (!name || !value) return null;
    properties.push(`${name}=${value}`);
  }
  return properties.join(',');
}

function routerMiddlewareDetail(
  expression: import('typescript').Expression,
): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (
    !ts.isCallExpression(expression)
    || !ts.isPropertyAccessExpression(expression.expression)
    || !ts.isIdentifier(expression.expression.expression)
    || !['express', 'expressFactory'].includes(expression.expression.expression.text)
    || expression.expression.name.text !== 'json'
    || expression.arguments.length > 1
  ) {
    return null;
  }
  if (expression.arguments.length === 0) return 'express.json';
  const options = objectLiteralDescription(expression.arguments[0]);
  return options === null ? null : `express.json(${options})`;
}

function routerRegistrations(definition: RouterFactoryDefinition): RouteRegistration[] {
  const parsed = sourceFile(definition.filePath);
  const factory = functionDeclaration(parsed, definition.factoryName);
  if (!factory?.body) return [];

  const registrations: RouteRegistration[] = [];
  const visit = (node: import('typescript').Node): void => {
    if (node !== factory.body && isFunctionLike(node)) return;
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === 'router'
      && node.arguments[0]
    ) {
      if (node.expression.name.text === 'use') {
        const detail = node.arguments.length === 1
          ? routerMiddlewareDetail(node.arguments[0])
          : null;
        assert(
          detail,
          `Unsupported router middleware in ${definition.filePath}:${node.getStart(parsed)}`,
        );
        registrations.push({
          detail,
          method: 'MIDDLEWARE',
          path: '/',
          position: node.getStart(parsed),
        });
        return;
      }
      if (!HTTP_METHODS.has(node.expression.name.text)) return;
      const routes = literalPaths(node.arguments[0]);
      assert(
        routes.length > 0,
        `Unsupported router path in ${definition.filePath}:${node.getStart(parsed)}`,
      );
      for (const route of routes) {
        registrations.push({
          method: node.expression.name.text.toUpperCase(),
          path: route,
          position: node.getStart(parsed),
        });
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(factory.body);
  return registrations.sort((left, right) => left.position - right.position);
}

function mountedRouterFactory(
  call: import('typescript').CallExpression,
  imports: Map<string, ImportedSymbol>,
): ImportedSymbol | null {
  for (const argument of call.arguments.slice(1)) {
    if (!ts.isCallExpression(argument) || !ts.isIdentifier(argument.expression)) continue;
    const imported = imports.get(argument.expression.text);
    if (imported) return imported;
  }
  return null;
}

function joinRoutePath(mountPath: string, routerPath: string): string {
  if (routerPath === '/') return mountPath;
  return `${mountPath.replace(/\/$/, '')}/${routerPath.replace(/^\//, '')}`;
}

function propertyPath(expression: import('typescript').Expression): string {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    const owner = propertyPath(expression.expression);
    return owner ? `${owner}.${expression.name.text}` : '';
  }
  return '';
}

function unwrapParentheses(expression: import('typescript').Expression): import('typescript').Expression {
  return ts.isParenthesizedExpression(expression)
    ? unwrapParentheses(expression.expression)
    : expression;
}

function logicalAndTerms(expression: import('typescript').Expression): import('typescript').Expression[] {
  const unwrapped = unwrapParentheses(expression);
  if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return [...logicalAndTerms(unwrapped.left), ...logicalAndTerms(unwrapped.right)];
  }
  return [unwrapped];
}

function strictEnvironmentEquality(
  expression: import('typescript').Expression,
  environmentName: string,
  expectedValue: string,
): boolean {
  const unwrapped = unwrapParentheses(expression);
  if (!ts.isBinaryExpression(unwrapped) || unwrapped.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) {
    return false;
  }
  const matches = (left: import('typescript').Expression, right: import('typescript').Expression) => (
    propertyPath(left) === `process.env.${environmentName}`
    && ts.isStringLiteralLike(right)
    && right.text === expectedValue
  );
  return matches(unwrapped.left, unwrapped.right) || matches(unwrapped.right, unwrapped.left);
}

function isE2eCloseWebsocketGuard(expression: import('typescript').Expression): boolean {
  const terms = logicalAndTerms(expression);
  return terms.length === 2
    && terms.some(term => strictEnvironmentEquality(term, 'NODE_ENV', 'test'))
    && terms.some(term => strictEnvironmentEquality(term, 'FARMING_E2E_FAKE_EXECUTABLES', '1'));
}

function enclosingConditionals(
  node: import('typescript').Node,
  parsed: import('typescript').SourceFile,
): import('typescript').IfStatement[] {
  const conditions: import('typescript').IfStatement[] = [];
  for (let parent = node.parent; parent && parent !== parsed; parent = parent.parent) {
    if (ts.isIfStatement(parent)) conditions.push(parent);
  }
  return conditions;
}

function isDescendantOf(node: import('typescript').Node, ancestor: import('typescript').Node): boolean {
  for (let parent: import('typescript').Node | undefined = node; parent; parent = parent.parent) {
    if (parent === ancestor) return true;
  }
  return false;
}

function isTokenAuthMiddleware(expression: import('typescript').Expression): boolean {
  return ts.isCallExpression(expression)
    && expression.arguments.length === 0
    && ts.isPropertyAccessExpression(expression.expression)
    && ts.isIdentifier(expression.expression.expression)
    && expression.expression.expression.text === 'tokenAuth'
    && expression.expression.name.text === 'middleware';
}

function registrationLabel(registration: RouteRegistration): string {
  const detail = registration.detail ? ` [${registration.detail}]` : '';
  const guard = registration.guard ? ` [guard:${registration.guard}]` : '';
  return `${registration.method} ${registration.path}${detail}${guard}`;
}

function serverApiRouteManifest(serverPath: string): string[] {
  const parsed = sourceFile(serverPath);
  const imports = importedSymbols(parsed);
  const registrations: RouteRegistration[] = [];

  const visit = (node: import('typescript').Node): void => {
    if (node !== parsed && isFunctionLike(node)) return;
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === 'app'
      && [...HTTP_METHODS, 'use'].includes(node.expression.name.text)
      && node.arguments[0]
    ) {
      const position = node.getStart(parsed);
      if (node.expression.name.text === 'use' && isTokenAuthMiddleware(node.arguments[0])) {
        assert.strictEqual(
          enclosingConditionals(node, parsed).length,
          0,
          'tokenAuth.middleware() must remain unconditionally registered',
        );
        registrations.push({
          detail: 'tokenAuth.middleware',
          method: 'MIDDLEWARE',
          path: '*',
          position,
        });
        return;
      }
      const paths = literalPaths(node.arguments[0])
        .filter(route => route === '/j/:code' || route === '/api' || route.startsWith('/api/'));
      const method = node.expression.name.text;
      for (const route of paths) {
        const conditions = enclosingConditionals(node, parsed);
        let guard: string | undefined;
        if (route === '/api/control/e2e/close-websockets') {
          assert.strictEqual(conditions.length, 1, `${route} must have exactly one registration guard`);
          assert(
            isE2eCloseWebsocketGuard(conditions[0].expression),
            `${route} must require NODE_ENV=test and FARMING_E2E_FAKE_EXECUTABLES=1`,
          );
          assert(
            isDescendantOf(node, conditions[0].thenStatement),
            `${route} must be registered in the guarded branch`,
          );
          guard = 'test-e2e';
        } else {
          assert.strictEqual(conditions.length, 0, `Unexpected conditional API registration: ${route}`);
        }
        if (method !== 'use') {
          registrations.push({ guard, method: method.toUpperCase(), path: route, position });
          continue;
        }
        const mountedFactory = mountedRouterFactory(node, imports);
        if (!mountedFactory || !mountedFactory.moduleSpecifier.startsWith('.')) {
          assert(OPAQUE_API_MOUNTS.has(route), `API mount must resolve to a repository router: ${route}`);
          registrations.push({ method: 'USE', path: route, position });
          continue;
        }
        const routerSource = resolveTypeScriptSource(serverPath, mountedFactory.moduleSpecifier);
        assert(routerSource, `Cannot resolve router module for API mount: ${route}`);
        const definition = resolveRouterFactoryDefinition(routerSource, mountedFactory.importedName);
        assert(definition, `Cannot resolve router factory for API mount: ${route}`);
        const childRoutes = routerRegistrations(definition);
        assert(
          childRoutes.some(child => HTTP_METHODS.has(child.method.toLowerCase())),
          `Repository router has no statically resolved routes: ${route}`,
        );
        childRoutes.forEach((child, index) => registrations.push({
          detail: child.detail,
          method: child.method,
          path: joinRoutePath(route, child.path),
          position: position + index / 1000,
        }));
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);

  const tokenAuthRegistrations = registrations.filter(registration => (
    registration.detail === 'tokenAuth.middleware'
  ));
  assert.strictEqual(tokenAuthRegistrations.length, 1, 'Expected exactly one tokenAuth.middleware() registration');
  const tokenAuthPosition = tokenAuthRegistrations[0].position;
  assert(
    registrations
      .filter(registration => registration.path.startsWith('/api/'))
      .every(registration => registration.position > tokenAuthPosition),
    'Every API route must remain registered after tokenAuth.middleware()',
  );

  return registrations
    .sort((left, right) => left.position - right.position)
    .map(registrationLabel);
}

const EXPECTED_API_ROUTE_MANIFEST = [
  'GET /j/:code',
  'MIDDLEWARE * [tokenAuth.middleware]',
  'GET /api/auth/status',
  'MIDDLEWARE /api/share/qr-ticket [setNoStoreHeader]',
  'POST /api/share/qr-ticket',
  'DELETE /api/share/qr-ticket/:code',
  'MIDDLEWARE /api/files [express.json(limit=3mb)]',
  'GET /api/files/raw',
  'GET /api/files/previews/:sessionId/:scope/*',
  'PUT /api/files/file',
  'MIDDLEWARE /api/browsers [express.json(limit=2mb)]',
  'GET /api/browsers/capability',
  'GET /api/browsers/extension',
  'GET /api/browsers/extension/tabs',
  'POST /api/browsers/extension/prepare',
  'DELETE /api/browsers/extension/prepare',
  'POST /api/browsers/isolated/prepare',
  'GET /api/browsers',
  'POST /api/browsers',
  'PATCH /api/browsers/:id',
  'POST /api/browsers/:id/start',
  'POST /api/browsers/:id/stop',
  'DELETE /api/browsers/:id',
  'POST /api/browsers/:id/navigate',
  'POST /api/browsers/:id/action',
  'MIDDLEWARE /api/computers [express.json(limit=1mb)]',
  'GET /api/computers/capability',
  'POST /api/computers/prepare',
  'GET /api/computers',
  'POST /api/computers',
  'PATCH /api/computers/:id',
  'POST /api/computers/:id/start',
  'POST /api/computers/:id/stop',
  'DELETE /api/computers/:id',
  'POST /api/computers/:id/control',
  'POST /api/computers/:id/tool/:tool',
  'GET /api/computers/:id/viewer-config',
  'GET /api/computers/:id/viewer/*',
  'GET /api/computers/:id/viewer',
  'MIDDLEWARE /api/review-sessions [express.json(limit=16kb)]',
  'POST /api/review-sessions',
  'POST /api/review-sessions/acp',
  'POST /api/review-sessions/acp/preview',
  'GET /api/review-sessions/:reviewId',
  'POST /api/review-sessions/:reviewId/revisions',
  'GET /api/reviews/comparison-sources',
  'GET /api/reviews/working-copy/patch',
  'GET /api/reviews/working-copy',
  'GET /api/reviews/working-copy/files/:filePath/diff',
  'GET /api/reviews/working-copy/files/:filePath/context',
  'GET /api/reviews/git-range/patch',
  'GET /api/reviews/git-range',
  'GET /api/reviews/git-range/files/:filePath/diff',
  'GET /api/reviews/git-range/files/:filePath/context',
  'MIDDLEWARE /api/reviews [express.json(limit=32kb)]',
  'GET /api/reviews/:reviewId/revisions/:patchset/files',
  'PUT /api/reviews/:reviewId/revisions/:patchset/files/:filePath/reviewed',
  'DELETE /api/reviews/:reviewId/revisions/:patchset/files/:filePath/reviewed',
  'GET /api/reviews/:reviewId/patchsets/:patchset/comments',
  'POST /api/reviews/:reviewId/patchsets/:patchset/comments',
  'DELETE /api/reviews/:reviewId/patchsets/:patchset/comments/:commentId',
  'PATCH /api/reviews/:reviewId/patchsets/:patchset/comments/:commentId',
  'POST /api/control/e2e/close-websockets [guard:test-e2e]',
  'MIDDLEWARE /api/control [express.json(limit=1mb)]',
  'GET /api/control/agents',
  'POST /api/control/agents',
  'POST /api/control/agents/:agentId/messages',
  'POST /api/control/agents/:agentId/input',
  'POST /api/control/agents/:agentId/title',
  'POST /api/control/agents/:agentId/clear',
  'GET /api/control/agents/:agentId/output',
  'DELETE /api/control/agents/:agentId',
  'GET /api/executables',
  'GET /api/workspaces/complete',
  'POST /api/workspaces/recent',
  'MIDDLEWARE /api/workspaces [express.json(limit=8kb)]',
  'GET /api/workspaces/browse',
  'POST /api/workspaces/prepare',
  'GET /api/skills',
  'GET /api/agent-extensions',
  'GET /api/slash-commands',
  'POST /api/attachments/image',
  'POST /api/attachments/audio',
  'GET /api/codex/models',
  'GET /api/claude/settings',
  'GET /api/usage',
  'GET /api/usage/day',
  'POST /api/provider-context-windows',
  'POST /api/codex/context-windows',
  'GET /api/update',
  'POST /api/update/install',
  'POST /api/update/restart',
  'GET /api/codex/sessions',
  'GET /api/agent-sessions',
  'GET /api/agent-sessions/search',
  'PATCH /api/agent-sessions/:provider/:sessionId',
  'POST /api/agent-sessions/:provider/:sessionId/archive',
  'POST /api/main-page-agent-sessions',
  'GET /api/themes',
  'GET /api/settings',
  'GET /api/workspaces/discovered',
  'GET /api/agents/:agentId/session-text',
  'GET /api/agents/:agentId/acp-session',
  'GET /api/agents/:agentId/acp-transcript',
  'POST /api/agents/:agentId/acp-transcript/prepare',
  'GET /api/agents/:agentId/acp-media/:entryId/:mediaId',
  'GET /api/agents/:agentId/acp-tool-details/:toolCallId',
  'POST /api/agents/:agentId/acp-terminals/:terminalId/kill',
  'POST /api/agents/:agentId/acp-terminals/:terminalId/input',
  'POST /api/agents/:agentId/acp-terminals/:terminalId/resize',
  'POST /api/agents/:agentId/acp-subagents/:sessionId/cancel',
  'POST /api/agents/:agentId/acp-patches/:toolCallId/decision',
  'GET /api/agents/:agentId/acp-sessions',
  'POST /api/agents/:agentId/acp-permission',
  'POST /api/agents/:agentId/acp-elicitation',
  'POST /api/agents/:agentId/acp-session/authenticate',
  'POST /api/agents/:agentId/acp-session/logout',
  'POST /api/agents/:agentId/acp-session/reconnect',
  'POST /api/agents/:agentId/acp-session/fork',
  'DELETE /api/agents/:agentId/acp-sessions/:sessionId',
  'POST /api/agents/:agentId/acp-session/close',
  'PATCH /api/agents/:agentId/acp-session',
  'POST /api/agents/:agentId/codex-terminal-profile',
  'PATCH /api/agents/:agentId',
  'POST /api/agents/:agentId/reorder',
  'POST /api/agents/:agentId/fork',
  'POST /api/projects/reveal',
  'POST /api/projects/mount',
  'POST /api/projects/mount-file',
  'POST /api/projects/remove',
  'POST /api/projects/pin',
  'POST /api/projects/reorder',
  'PATCH /api/projects/name',
  'POST /api/projects/create-worktree',
  'POST /api/projects/delete-worktree',
  'POST /api/codex/sessions/:sessionId/resume',
  'POST /api/agent-sessions/:provider/:sessionId/resume',
  'POST /api/settings',
  'POST /api/themes/:themeId/set',
  'GET /api/themes/:themeId/settings',
  'POST /api/themes/:themeId/settings',
  'GET /api/themes/:themeId',
];

function run(): void {
  const serverPath = path.resolve(__dirname, '../server.cts');
  const actual = serverApiRouteManifest(serverPath);
  assert.deepStrictEqual(
    actual,
    EXPECTED_API_ROUTE_MANIFEST,
    'API route methods, paths, and registration order must remain stable across router extraction',
  );
  console.log('server API route manifest contract passed');
}

run();
