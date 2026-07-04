#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const projectRoot = path.resolve(__dirname, '..');
const entryOutfile = process.env.FARMING_CLI_BUNDLE_ENTRY
  || path.join(projectRoot, 'backend', 'farming-app-cli.pkg.js');
const workerOutfile = process.env.FARMING_CLI_BUNDLE_WORKER
  || path.join(projectRoot, 'backend', 'terminal-screen-worker-thread.pkg.js');

const dynamicRequire = [
  'var __farmingDynamicRequire = typeof module !== "undefined" && module.require',
  '  ? module.require.bind(module)',
  '  : require;',
].join('\n');

const expressViewDynamicRequirePlugin = {
  name: 'farming-express-view-dynamic-require',
  setup(build) {
    build.onLoad({ filter: /node_modules[\\/]express[\\/]lib[\\/]view\.js$/ }, async (args) => {
      const source = await fs.promises.readFile(args.path, 'utf8');
      const replaced = source.replace(
        'var fn = require(mod).__express',
        'var fn = __farmingDynamicRequire(mod).__express'
      );
      if (replaced === source) {
        throw new Error(`Express view dynamic require pattern changed in ${args.path}`);
      }

      return {
        contents: replaced.replace("'use strict';", `'use strict';\n${dynamicRequire}`),
        loader: 'js',
      };
    });
  },
};

const commonOptions = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node16',
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
};

async function main() {
  await esbuild.build({
    ...commonOptions,
    entryPoints: [path.join(projectRoot, 'backend', 'farming-app-cli.js')],
    outfile: entryOutfile,
    plugins: [expressViewDynamicRequirePlugin],
  });

  await esbuild.build({
    ...commonOptions,
    entryPoints: [path.join(projectRoot, 'backend', 'terminal-screen-worker-thread.js')],
    outfile: workerOutfile,
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
