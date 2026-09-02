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
  /const inheritedPlaywrightConfigDir = process\.env\.FARMING_PLAYWRIGHT_CONFIG_DIR;/,
  'Playwright must accept only the isolated lane config override',
);
assert.doesNotMatch(
  source,
  /(?:const|let|var)\s+\w+\s*=\s*process\.env\.FARMING_CONFIG_DIR[;\n]/,
  'Playwright must not read the inherited generic Farming config root',
);

assert.match(
  source,
  /const ownsConfigDir = !inheritedPlaywrightConfigDir;/,
  'Externally supplied lane config must not be removed by server cleanup',
);
assert.match(
  source,
  /process\.env\.FARMING_CONFIG_DIR = configDir;/,
  'The backend must receive the resolved isolated Playwright config root',
);

console.log('test-playwright-server-isolation passed');
