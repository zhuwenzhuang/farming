const fs = require('fs') as typeof import('fs');
const os = require('os') as typeof import('os');
const path = require('path') as typeof import('path');
const { createRequire } = require('module') as typeof import('module');
import { npmRuntimePackageRoot } from './npm-runtime-package.cjs';

interface NodePtyUtils {
  loadNativeModule(name: string): {
    dir: string;
    module: unknown;
  };
}

function isPackagedRuntime(): boolean {
  return Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg)
    || process.env.FARMING_PACKAGED_RUNTIME === '1';
}

function packagedNodePtyTargetDir(): string {
  const baseDir = process.env.FARMING_CONFIG_DIR || path.join(os.homedir(), '.farming');
  return path.join(baseDir, 'runtime', 'node-pty', `${process.platform}-${process.arch}`);
}

function copyIfExists(source: string, target: string, mode?: number): boolean {
  if (!fs.existsSync(source)) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let unchanged = false;
  try {
    const sourceStat = fs.statSync(source);
    const targetStat = fs.statSync(target);
    unchanged = sourceStat.size === targetStat.size
      && fs.readFileSync(source).equals(fs.readFileSync(target));
  } catch {
    unchanged = false;
  }
  if (!unchanged) {
    const temporary = `${target}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
      if (mode !== undefined) fs.chmodSync(temporary, mode);
      fs.renameSync(temporary, target);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  } else if (mode !== undefined) {
    fs.chmodSync(target, mode);
  }
  return true;
}

function nodePtyPackageRoot(): string {
  if (isPackagedRuntime()) {
    return path.join(__dirname, '..', 'node_modules', 'node-pty');
  }

  return path.dirname(createRequire(__filename).resolve('node-pty/package.json'));
}

function loadNativeModule(modulePath: string): unknown {
  const commonJsModule = module as NodeJS.Module & { require?: NodeRequire };
  const runtimeRequire = commonJsModule.require ? commonJsModule.require.bind(commonJsModule) : require;
  return runtimeRequire(modulePath);
}

function loadNodePtyNativeModule(packageRoot: string, name: string): { dir: string; module: unknown } {
  const libraryDir = path.join(packageRoot, 'lib');
  const dirs = ['build/Release', 'build/Debug', `prebuilds/${process.platform}-${process.arch}`];
  for (const dir of dirs) {
    for (const relative of ['..', '.']) {
      const nativeDir = path.resolve(libraryDir, relative, dir);
      const nativePath = path.join(nativeDir, `${name}.node`);
      if (!fs.existsSync(nativePath)) continue;
      // An existing image artifact that cannot dlopen is a real load failure.
      // Do not mask it with MODULE_NOT_FOUND from a later search candidate.
      try {
        return { dir: nativeDir, module: loadNativeModule(nativePath) };
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`Failed to load node-pty native module ${nativePath}: ${detail}`, { cause });
      }
    }
  }
  throw new Error(`Missing node-pty native module ${name}.node in ${packageRoot}; checked: ${dirs.join(', ')}`);
}

function loadNodePtyPackage(packageRoot: string): typeof import('node-pty') {
  const utils = loadNativeModule(path.join(packageRoot, 'lib/utils.js')) as NodePtyUtils;
  utils.loadNativeModule = name => loadNodePtyNativeModule(packageRoot, name);
  return loadNativeModule(packageRoot) as typeof import('node-pty');
}

function preparePackagedNodePtyRuntime(nativeName = 'pty'): string {
  if (!isPackagedRuntime()) return '';
  const packageRoot = nodePtyPackageRoot();
  const prebuildDir = path.join(packageRoot, 'prebuilds', `${process.platform}-${process.arch}`);
  const targetDir = packagedNodePtyTargetDir();
  const nativeFile = `${nativeName}.node`;
  const nativeCopied = copyIfExists(
    path.join(prebuildDir, nativeFile),
    path.join(targetDir, nativeFile)
  );
  copyIfExists(
    path.join(prebuildDir, 'spawn-helper'),
    path.join(targetDir, 'spawn-helper'),
    0o755
  );
  return nativeCopied ? targetDir : '';
}

function copyPackagedSpawnHelper(): string {
  return preparePackagedNodePtyRuntime('pty');
}

function loadNodePty(): typeof import('node-pty') {
  if (!isPackagedRuntime()) {
    const applicationRoot = path.resolve(__dirname, '..');
    const runtimeRoot = npmRuntimePackageRoot(applicationRoot, `${process.platform}-${process.arch}`);
    if (runtimeRoot !== applicationRoot) {
      return loadNodePtyPackage(path.join(runtimeRoot, 'dist/runtime/node-pty'));
    }
    return loadNodePtyPackage(nodePtyPackageRoot());
  }
  if (isPackagedRuntime()) {
    const utils = require('node-pty/lib/utils') as NodePtyUtils;
    utils.loadNativeModule = function patchedLoadNativeModule(name: string) {
      const runtimeDir = preparePackagedNodePtyRuntime(name);
      if (runtimeDir) {
        return {
          dir: runtimeDir,
          module: loadNativeModule(path.join(runtimeDir, `${name}.node`)),
        };
      }
      throw new Error(`Failed to load packaged node-pty native module: ${name}.node`);
    };
  }

  return require('node-pty') as typeof import('node-pty');
}

const nodePty = loadNodePty();

export {
  copyIfExists,
  copyPackagedSpawnHelper,
  isPackagedRuntime,
  loadNodePtyNativeModule,
  nodePty,
  preparePackagedNodePtyRuntime,
};
