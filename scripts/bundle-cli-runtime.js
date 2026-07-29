#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const projectRoot = path.resolve(__dirname, '..');
const entryOutfile = process.env.FARMING_CLI_BUNDLE_ENTRY
  || path.join(projectRoot, 'backend', 'farming-app-cli.pkg.js');
const workerOutfile = process.env.FARMING_CLI_BUNDLE_WORKER
  || path.join(projectRoot, 'backend', 'terminal-screen-worker-thread.pkg.js');
const usageWorkerOutfile = process.env.FARMING_CLI_BUNDLE_USAGE_WORKER
  || path.join(projectRoot, 'backend', 'usage-history-worker.pkg.js');
const packagedCodexBridge = path.join(projectRoot, 'backend', 'acp', 'packaged-codex-acp.js');
const packagedClaudeBridge = path.join(projectRoot, 'backend', 'acp', 'packaged-claude-acp.js');
const packagedCodexEntry = path.join(projectRoot, 'dist', 'acp', 'codex-acp-1.1.4.mjs');
const packagedClaudeEntry = path.join(projectRoot, 'dist', 'acp', 'claude-agent-acp-0.59.0.mjs');

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

const packagedAcpPlugin = {
  name: 'farming-packaged-acp',
  setup(build) {
    build.onLoad({ filter: /packaged-(?:codex|claude)-acp\.js$/ }, async (args) => {
      const filePath = path.resolve(args.path);
      const isCodex = filePath === path.resolve(packagedCodexBridge);
      const isClaude = filePath === path.resolve(packagedClaudeBridge);
      if (!isCodex && !isClaude) return null;
      const label = isCodex ? 'Codex' : 'Claude';
      const argument = isCodex ? '--farming-codex-acp' : '--farming-claude-acp';
      const entry = isCodex ? packagedCodexEntry : packagedClaudeEntry;
      return {
        contents: [
          `const PACKAGED_${label.toUpperCase()}_ACP_ARG = ${JSON.stringify(argument)};`,
          `async function runPackaged${label}Acp() {`,
          `  if (!process.pkg) throw new Error('The packaged ${label} ACP entry is available only in a standalone Farming CLI');`,
          `  require(${JSON.stringify(entry)});`,
          '}',
          `module.exports = { PACKAGED_${label.toUpperCase()}_ACP_ARG, runPackaged${label}Acp };`,
        ].join('\n'),
        loader: 'js',
        resolveDir: path.dirname(args.path),
      };
    });

    build.onLoad({ filter: /claude-agent-acp-0\.59\.0\.mjs$/ }, async (args) => {
      if (path.resolve(args.path) !== path.resolve(packagedClaudeEntry)) return null;
      const source = await fs.promises.readFile(args.path, 'utf8');
      const marker = '// dist/index.js\nif (process.argv.includes("--cli")) {';
      const occurrences = source.split(marker).length - 1;
      if (occurrences !== 1) {
        throw new Error(`Expected one reviewed Claude ACP executable entry, found ${occurrences}`);
      }
      return {
        contents: `${source.replace(marker, `(async () => {\n${marker}`)}\n`
          + '})().catch((error) => {\n'
          + '  console.error(error?.stack || error);\n'
          + '  process.exitCode = 1;\n'
          + '});\n',
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
  banner: {
    js: 'const __farmingImportMetaUrl = require("url").pathToFileURL(__filename).href;',
  },
  define: {
    'import.meta.url': '__farmingImportMetaUrl',
  },
};

async function main() {
  await esbuild.build({
    ...commonOptions,
    entryPoints: [path.join(projectRoot, 'backend', 'farming-app-cli.js')],
    outfile: entryOutfile,
    plugins: [expressViewDynamicRequirePlugin, packagedAcpPlugin],
  });

  await esbuild.build({
    ...commonOptions,
    entryPoints: [path.join(projectRoot, 'backend', 'terminal-screen-worker-thread.cts')],
    outfile: workerOutfile,
  });

  await esbuild.build({
    ...commonOptions,
    target: 'node22',
    entryPoints: [path.join(projectRoot, 'backend', 'usage-history-worker.js')],
    outfile: usageWorkerOutfile,
    external: ['node:sqlite'],
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
