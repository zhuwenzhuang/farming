const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function atomicWriteJson(file, value, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const temporaryFile = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const suffix = options.trailingNewline ? '\n' : '';
  let descriptor = null;

  fileSystem.mkdirSync(path.dirname(file), { recursive: true });
  try {
    descriptor = fileSystem.openSync(temporaryFile, 'wx', options.mode);
    fileSystem.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}${suffix}`, 'utf8');
    fileSystem.fdatasyncSync(descriptor);
    fileSystem.closeSync(descriptor);
    descriptor = null;
    fileSystem.renameSync(temporaryFile, file);
  } finally {
    if (descriptor !== null) {
      try {
        fileSystem.closeSync(descriptor);
      } catch {
        // Preserve the original write failure.
      }
    }
    try {
      fileSystem.unlinkSync(temporaryFile);
    } catch {
      // A successful rename already removed the temporary path.
    }
  }
}

module.exports = {
  atomicWriteJson,
};
