import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = path.join(__dirname, '..', '..');
const source = fs.readFileSync(
  path.join(projectRoot, 'scripts', 'start-playwright-server.ts'),
  'utf8',
);

assert.match(
  source,
  /process\.env\.FARMING_CONFIG_DIR = configDir;/,
  'Playwright must always use its newly-created isolated config root',
);
assert.doesNotMatch(
  source,
  /process\.env\.FARMING_CONFIG_DIR = process\.env\.FARMING_CONFIG_DIR \|\| configDir;/,
  'Playwright must not inherit the parent Farming config root',
);

console.log('test-playwright-server-isolation passed');
