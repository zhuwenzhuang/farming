const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const projectRoot = path.join(__dirname, '..', '..');
const extensionsDir = path.join(projectRoot, 'extensions');
const configPath = path.join(projectRoot, 'tsconfig.json');

function collectExtensionFrontendSources(): string[] {
  const collected: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolutePath);
      else if (entry.isFile() && /\.tsx?$/.test(entry.name)) collected.push(absolutePath);
    }
  };
  for (const extension of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!extension.isDirectory()) continue;
    const frontendDir = path.join(extensionsDir, extension.name, 'frontend');
    if (fs.existsSync(frontendDir)) walk(frontendDir);
  }
  return collected.sort();
}

/** Root file names come from `include` alone, so a file reached only through a src import never appears here. */
function resolveRootFileNames(includeOverride?: string[]): Set<string> {
  const readResult = ts.readConfigFile(configPath, ts.sys.readFile);
  assert(!readResult.error, `tsconfig.json must parse: ${configPath}`);
  const config = readResult.config;
  if (includeOverride) config.include = includeOverride;
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, projectRoot, undefined, configPath);
  assert.deepStrictEqual(parsed.errors, [], 'tsconfig.json include globs must resolve without errors');
  return new Set<string>(parsed.fileNames.map((file: string) => path.resolve(file)));
}

const relative = (absolutePath: string) => path.relative(projectRoot, absolutePath);

const sources = collectExtensionFrontendSources();
assert(sources.length > 0, 'Expected Extension frontend TypeScript sources to exist');

const ownedRootFiles = resolveRootFileNames();
for (const source of sources) {
  assert(
    ownedRootFiles.has(path.resolve(source)),
    `Extension frontend source must be explicitly owned by tsconfig.json include, not only reached`
      + ` transitively through src imports: ${relative(source)}`,
  );
}

// Guard against a vacuous pass: a src-only include must not claim these sources as root files,
// which is exactly the ownership gap the Extension include closes.
const srcOnlyRootFiles = resolveRootFileNames(['src']);
const srcOnlyOwned = sources.filter(source => srcOnlyRootFiles.has(path.resolve(source)));
assert.deepStrictEqual(
  srcOnlyOwned.map(relative),
  [],
  'A src-only include must not own Extension frontend sources, otherwise this gate proves nothing',
);

console.log(
  `test-extension-frontend-typecheck-ownership passed`
    + ` (${sources.length} Extension frontend sources owned by tsconfig.json)`,
);
