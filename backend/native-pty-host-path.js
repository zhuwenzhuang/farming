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

function nativePtyHostPrivateSocketHash(socketPath) {
  return crypto.createHash('sha256').update(socketPath).digest('hex').slice(0, 8);
}

function nativePtyHostPrivateSocketPath(socketPath, options = {}) {
  const pid = Number(options.pid || process.pid);
  const nonce = String(options.nonce || crypto.randomBytes(4).toString('hex'));
  return path.join(
    path.dirname(socketPath),
    `.fpty-${pid}-${nativePtyHostPrivateSocketHash(socketPath)}-${nonce}.sock`,
  );
}

function nativePtyHostPrivateSocketNamePattern(socketPath) {
  const hash = nativePtyHostPrivateSocketHash(socketPath);
  return new RegExp(`^\\.fpty-\\d+-${hash}-[a-f0-9]+\\.sock$`);
}

module.exports = {
  nativePtyHostPrivateSocketNamePattern,
  nativePtyHostPrivateSocketPath,
  nativePtyHostSocketPath,
};
