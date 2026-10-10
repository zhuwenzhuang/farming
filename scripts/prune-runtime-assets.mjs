import fs from 'node:fs';
import path from 'node:path';

// Vite copies public/ verbatim. Design masters and historical artwork stay in
// source control, but only the product's icons belong in a runtime image.
const root = path.resolve('dist/farming-2');
const runtimeFiles = new Set([
  'favicon-v2.ico', 'favicon-v2-16.png', 'favicon-v2-32.png', 'favicon-v2-48.png',
  'app-icon-v2-180.png', 'app-icon-v2-192.png', 'app-icon-v2-512.png',
  'app-icon-v2-maskable-512.png', 'site.webmanifest',
]);
for (const name of runtimeFiles) {
  if (!fs.statSync(path.join(root, name)).isFile()) throw new Error(`Missing runtime icon: ${name}`);
}
for (const name of fs.readdirSync(root)) {
  if (!runtimeFiles.has(name)) fs.rmSync(path.join(root, name), { recursive: true });
}
