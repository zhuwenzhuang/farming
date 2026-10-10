#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [stageArgument, outputArgument] = process.argv.slice(2);
assert(stageArgument && outputArgument, 'Usage: package-npm-runtimes.mjs <isolated package stage> <output directory>');
const stage = path.resolve(stageArgument);
const output = path.resolve(outputArgument);
const manifestPath = path.join(stage, 'package.json');
const application = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
assert(application.name === 'farming-code' && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(application.version));
assert(!application.farmingRuntimePackages, 'Refuse to split an already assembled image');
const platforms = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64'];
const temporary = fs.mkdtempSync(path.join(path.dirname(stage), 'npm-runtimes-'));
const packages = [];
fs.mkdirSync(output, { recursive: true });
try {
  for (const platform of platforms) {
    const root = path.join(temporary, platform);
    const [os, cpu] = platform.split('-');
    const version = `${application.version}-runtime-${platform}`;
    const directories = [`dist/runtime/ripgrep/${platform}`];
    if (platform !== 'win32-arm64') directories.push(`dist/runtime/agent-browser/${platform}`);
    if (os === 'linux') directories.push(`dist/runtime/agent-browser/${platform}-musl`);
    if (platform === 'linux-x64') directories.push('dist/runtime/glibc228');
    fs.mkdirSync(root);
    for (const directory of directories) {
      assert(fs.statSync(path.join(stage, directory)).isDirectory(), `Missing prepared runtime: ${directory}`);
      fs.cpSync(path.join(stage, directory), path.join(root, directory), { recursive: true });
    }
    // Preserve node-pty's own module-relative layout, with only this platform's
    // prebuilds. Loading through Farming's PTY boundary needs no install hook.
    const ptySource = path.join(stage, 'node_modules/node-pty');
    const ptyTarget = path.join(root, 'dist/runtime/node-pty');
    for (const name of ['package.json', 'LICENSE', 'lib', `prebuilds/${platform}`]) {
      fs.cpSync(path.join(ptySource, name), path.join(ptyTarget, name), { recursive: true });
    }
    for (const name of fs.readdirSync(path.join(ptyTarget, 'lib'))) {
      if (/\.(map|test\.js)$/.test(name)) fs.rmSync(path.join(ptyTarget, 'lib', name));
    }
    for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) fs.copyFileSync(path.join(stage, name), path.join(root, name));
    const metadata = {
      name: 'farming-code', version,
      description: `Prepared Farming native runtimes for ${platform}`,
      license: application.license, repository: application.repository,
      os: [os], cpu: [cpu], files: ['dist/', 'LICENSE', 'THIRD_PARTY_NOTICES.md'],
      farmingRuntimePlatform: platform, gitHead: application.gitHead,
    };
    fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(metadata, null, 2)}\n`);
    const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', output], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
    const info = Array.isArray(packed) ? packed[0] : packed['farming-code'];
    const entries = new Set(info.files.map(file => file.path));
    const required = [
      `dist/runtime/ripgrep/${platform}/${os === 'win32' ? 'rg.exe' : 'rg'}`,
      'dist/runtime/node-pty/lib/index.js', 'dist/runtime/node-pty/LICENSE',
      ...((os === 'win32' ? ['conpty.node', 'conpty_console_list.node', 'conpty/conpty.dll', 'conpty/OpenConsole.exe']
        : os === 'darwin' ? ['pty.node', 'spawn-helper'] : ['pty.node']).map(name => `dist/runtime/node-pty/prebuilds/${platform}/${name}`)),
    ];
    if (platform !== 'win32-arm64') required.push(`dist/runtime/agent-browser/${platform}/${os === 'win32' ? 'agent-browser.exe' : 'agent-browser'}`);
    if (os === 'linux') required.push(`dist/runtime/agent-browser/${platform}-musl/agent-browser`);
    if (platform === 'linux-x64') required.push('dist/runtime/glibc228/ld-2.28.so');
    for (const name of required) assert(entries.has(name), `Carrier omitted runtime: ${platform}/${name}`);
    for (const name of entries) {
      assert(!name.endsWith('.pdb'), `Carrier duplicated debug symbols: ${name}`);
      const match = name.match(/\/prebuilds\/([^/]+)\//);
      assert(!match || match[1] === platform, `Carrier includes another platform: ${name}`);
    }
    packages.push({ platform, version, filename: info.filename, size: info.size, unpackedSize: info.unpackedSize, integrity: info.integrity });
    application.optionalDependencies[`farming-code-runtime-${platform}`] = `npm:farming-code@${version}`;
  }
  // All carriers exist before removing their bytes from the main image.
  for (const directory of ['agent-browser', 'ripgrep', 'glibc228']) {
    fs.rmSync(path.join(stage, 'dist/runtime', directory), { recursive: true });
  }
  // node-addon-api is node-pty's build-time header dependency; neither is a
  // dependency of the main published image once the prepared PTY is split.
  delete application.dependencies['node-pty'];
  for (const key of ['bundledDependencies', 'bundleDependencies']) {
    application[key] = application[key].filter(name => name !== 'node-pty');
  }
  for (const name of ['node-pty', 'node-addon-api']) fs.rmSync(path.join(stage, 'node_modules', name), { recursive: true });
  application.farmingRuntimePackages = 1;
  fs.writeFileSync(manifestPath, `${JSON.stringify(application, null, 2)}\n`);
  fs.writeFileSync(path.join(output, 'runtime-packages.json'), `${JSON.stringify(packages, null, 2)}\n`);
  console.error(`Prepared ${packages.length} OS/CPU runtime packages; main image contains no native runtime payloads.`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
