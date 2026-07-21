const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const sourcePackageDir = path.join(projectRoot, 'node_modules/ghostty-web');
const sourceDir = path.join(sourcePackageDir, 'dist');
const targetDir = path.join(projectRoot, 'frontend/vendor/ghostty-web');

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyDirectoryContents(source, target) {
  ensureDirectory(target);

  const entries = fs.readdirSync(source, { withFileTypes: true });
  entries.forEach((entry) => {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);

    if (entry.isDirectory()) {
      copyDirectoryContents(sourcePath, targetPath);
      return;
    }

    fs.copyFileSync(sourcePath, targetPath);
  });
}

function replaceOnce(filePath, search, replacement) {
  const source = fs.readFileSync(filePath, 'utf8');
  if (!source.includes(search)) {
    throw new Error(`Expected Ghostty vendor pattern not found in ${filePath}`);
  }

  fs.writeFileSync(filePath, source.replace(search, replacement));
}

function patchGhosttyVendor() {
  // The upstream build ceilings the measured "M" width, which makes CJK and
  // soft-wrapped terminal content visibly wider than native Ghostty. Keep this
  // local runtime patch here so every source and release build regenerates the
  // same reviewed vendored fix from the pinned dependency.
  replaceOnce(
    path.join(targetDir, 'ghostty-web.js'),
    'const g = B.measureText("M"), E = Math.ceil(g.width),',
    'const g = B.measureText("M"), E = g.width,'
  );
  replaceOnce(
    path.join(targetDir, 'ghostty-web.umd.cjs'),
    'const g=B.measureText("M"),E=Math.ceil(g.width),',
    'const g=B.measureText("M"),E=g.width,'
  );
}

function syncGhosttyVendor() {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`ghostty-web dist directory not found: ${sourceDir}`);
  }

  copyDirectoryContents(sourceDir, targetDir);
  fs.copyFileSync(path.join(sourcePackageDir, 'LICENSE'), path.join(targetDir, 'LICENSE'));
  patchGhosttyVendor();
  console.log(`Synced Ghostty vendor assets to ${targetDir}`);
}

syncGhosttyVendor();
