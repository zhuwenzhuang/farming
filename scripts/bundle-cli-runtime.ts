#!/usr/bin/env -S npx tsx

import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';

const projectRoot = path.resolve(__dirname, '..');
const entryOutfile = process.env.FARMING_CLI_BUNDLE_ENTRY
  || path.join(projectRoot, 'backend', 'farming-app-cli.pkg.js');
const workerOutfile = process.env.FARMING_CLI_BUNDLE_WORKER
  || path.join(projectRoot, 'backend', 'terminal-screen-worker-thread.pkg.js');
const usageWorkerOutfile = process.env.FARMING_CLI_BUNDLE_USAGE_WORKER
  || path.join(projectRoot, 'backend', 'usage-history-worker.pkg.js');
const packagedCodexBridge = path.join(projectRoot, 'backend', 'acp', 'packaged-codex-acp.cts');
const packagedClaudeBridge = path.join(projectRoot, 'backend', 'acp', 'packaged-claude-acp.cts');
const packagedPiBridge = path.join(projectRoot, 'backend', 'acp', 'packaged-pi-acp.cts');
const packagedCodexRuntimeBridge = path.join(projectRoot, 'backend', 'acp', 'packaged-codex-acp.cjs');
const packagedClaudeRuntimeBridge = path.join(projectRoot, 'backend', 'acp', 'packaged-claude-acp.cjs');
const packagedPiRuntimeBridge = path.join(projectRoot, 'backend', 'acp', 'packaged-pi-acp.cjs');
const packagedCodexEntry = path.join(projectRoot, 'dist', 'acp', 'codex-acp-1.7.0.mjs');
const packagedClaudeEntry = path.join(projectRoot, 'dist', 'acp', 'claude-agent-acp-0.70.0.mjs');
const packagedPiEntry = path.join(projectRoot, 'dist', 'acp', 'pi-acp-0.0.33.mjs');

const dynamicRequire = [
  'var __farmingDynamicRequire = typeof module !== "undefined" && module.require',
  '  ? module.require.bind(module)',
  '  : require;',
].join('\n');

const expressViewDynamicRequirePlugin: esbuild.Plugin = {
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

const packagedAcpPlugin: esbuild.Plugin = {
  name: 'farming-packaged-acp',
  setup(build) {
    build.onLoad({ filter: /packaged-(?:codex|claude|pi)-acp\.(?:cjs|cts)$/ }, async (args) => {
      const filePath = path.resolve(args.path);
      const isCodex = [packagedCodexBridge, packagedCodexRuntimeBridge].some(candidate => filePath === path.resolve(candidate));
      const isClaude = [packagedClaudeBridge, packagedClaudeRuntimeBridge].some(candidate => filePath === path.resolve(candidate));
      const isPi = [packagedPiBridge, packagedPiRuntimeBridge].some(candidate => filePath === path.resolve(candidate));
      if (!isCodex && !isClaude && !isPi) return null;
      const label = isCodex ? 'Codex' : isClaude ? 'Claude' : 'Pi';
      const argument = isCodex ? '--farming-codex-acp' : isClaude ? '--farming-claude-acp' : '--farming-pi-acp';
      const entry = isCodex ? packagedCodexEntry : isClaude ? packagedClaudeEntry : packagedPiEntry;
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

    build.onLoad({ filter: /claude-agent-acp-0\.70\.0\.mjs$/ }, async (args) => {
      if (path.resolve(args.path) !== path.resolve(packagedClaudeEntry)) return null;
      const source = await fs.promises.readFile(args.path, 'utf8');
      const marker = 'if (process.argv.includes("--cli")) {';
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

    build.onLoad({ filter: /pi-acp-0\.0\.33\.mjs$/ }, async (args) => {
      if (path.resolve(args.path) !== path.resolve(packagedPiEntry)) return null;
      const source = await fs.promises.readFile(args.path, 'utf8');
      const marker = 'if (process.argv.includes("--terminal-login")) {';
      const occurrences = source.split(marker).length - 1;
      if (occurrences !== 1) {
        throw new Error(`Expected one reviewed Pi ACP executable entry, found ${occurrences}`);
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

const commonOptions: esbuild.BuildOptions = {
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

async function main(): Promise<void> {
  await esbuild.build({
    ...commonOptions,
    entryPoints: [path.join(projectRoot, 'backend', 'farming-app-cli.cts')],
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
    entryPoints: [path.join(projectRoot, 'backend', 'usage-history-worker.cts')],
    outfile: usageWorkerOutfile,
    external: ['node:sqlite'],
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
