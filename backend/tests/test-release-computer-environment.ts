import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Keep the standalone, dependency-free environment verifier covered by npm test.
execFileSync(process.execPath, ['--test', path.resolve(__dirname, '../../scripts/test-release-computer-environment.mjs')], {
  stdio: 'inherit', timeout: 10_000,
});
