const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');

function isPackagedRuntime() {
  return Boolean(process.pkg) || process.env.FARMING_PACKAGED_RUNTIME === '1';
}

function packagedNodePtyTargetDir() {
  const baseDir = process.env.FARMING_CONFIG_DIR || path.join(os.homedir(), '.farming');
  return path.join(baseDir, 'runtime', 'node-pty', `${process.platform}-${process.arch}`);
}

function copyIfExists(source, target, mode) {
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

function nodePtyPackageRoot() {
  if (isPackagedRuntime()) {
    return path.join(__dirname, '..', 'node_modules', 'node-pty');
  }

  return path.dirname(createRequire(__filename).resolve('node-pty/package.json'));
}

function loadNativeModule(modulePath) {
  const runtimeRequire = module.require ? module.require.bind(module) : require;
  return runtimeRequire(modulePath);
}

function preparePackagedNodePtyRuntime(nativeName = 'pty') {
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

function copyPackagedSpawnHelper() {
  return preparePackagedNodePtyRuntime('pty');
}

function loadNodePty() {
  if (isPackagedRuntime()) {
    const utils = require('node-pty/lib/utils');
    utils.loadNativeModule = function patchedLoadNativeModule(name) {
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

  return require('node-pty');
}

module.exports = loadNodePty();
module.exports.copyPackagedSpawnHelper = copyPackagedSpawnHelper;
module.exports.copyIfExists = copyIfExists;
module.exports.preparePackagedNodePtyRuntime = preparePackagedNodePtyRuntime;
module.exports.isPackagedRuntime = isPackagedRuntime;
