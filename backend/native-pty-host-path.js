const crypto = require('crypto');
const os = require('os');
const path = require('path');

function nativePtyHostSocketPath(configDir) {
  const root = configDir || process.env.FARMING_CONFIG_DIR || path.join(os.homedir(), '.farming');
  const hash = crypto
    .createHash('sha1')
    .update(path.resolve(root))
    .digest('hex')
    .slice(0, 12);

  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\farming-native-pty-${hash}`;
  }

  return path.join(os.tmpdir(), `farming-native-pty-${process.getuid ? process.getuid() : 'user'}-${hash}.sock`);
}

module.exports = {
  nativePtyHostSocketPath,
};
