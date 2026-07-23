#!/usr/bin/env node

const path = require('path');
const esbuild = require('esbuild');

const projectRoot = path.resolve(__dirname, '..');

esbuild.build({
  entryPoints: [path.join(projectRoot, 'backend', 'usage-history-scanner.ts')],
  outfile: path.join(projectRoot, 'backend', 'usage-history-scanner.generated.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['node:sqlite'],
  legalComments: 'none',
  logLevel: 'warning',
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
