import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// These projects run both on developer Macs and in Linux CI. A reviewed Mac
// baseline alone must not make preparation look complete before CI starts.
const root = path.resolve(__dirname, '..');
const tracked = execFileSync('git', ['ls-files', '-z', 'tests/e2e'], {
  cwd: root,
  encoding: 'utf8',
}).split('\0').filter(Boolean);
const macBaselines = tracked.filter(file => (
  /-(chromium|iphone-webkit)-darwin\.png$/.test(file)
  // The older display-flows captures explicitly run only on macOS. Their
  // behavioral assertions run everywhere; they are not cross-platform images.
  && !file.startsWith('tests/e2e/display-flows.spec.ts-snapshots/')
));
const missing = macBaselines
  .map(file => file.replace(/-darwin\.png$/, '-linux.png'))
  .filter(file => !fs.existsSync(path.join(root, file)));

if (missing.length > 0) {
  throw new Error(`Missing reviewed Linux visual baselines:\n${missing.join('\n')}\nCapture and review them on Linux; do not rename Mac screenshots.`);
}
console.log(`Visual platform baselines complete for ${macBaselines.length} tracked Mac snapshots.`);
