import { execFileSync } from 'node:child_process';
import path from 'node:path';

execFileSync(process.execPath, ['--test', path.resolve(__dirname, '../../scripts/run-release-browser-screen.test.mjs')], {
  stdio: 'inherit', timeout: 10_000,
});
