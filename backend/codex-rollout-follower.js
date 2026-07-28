const fs = require('fs');
const os = require('os');
const path = require('path');

function normalizePathValue(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed === path.sep) return trimmed;
  return trimmed.replace(/[\\/]+$/, '');
}

function sessionIdFromFilePath(filePath) {
  const match = path.basename(filePath).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return match ? match[1] : '';
}

function findCodexRolloutFile(sessionId, options = {}) {
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedSessionId) return '';

  const codexHome = normalizePathValue(options.codexHome || path.join(os.homedir(), '.codex'));
  const roots = [
    path.join(codexHome, 'sessions'),
    path.join(codexHome, 'archived_sessions'),
  ];

  for (const root of roots) {
    const stack = [root];
    while (stack.length > 0) {
      const directory = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
        } else if (
          entry.isFile()
          && entry.name.endsWith('.jsonl')
          && sessionIdFromFilePath(fullPath) === normalizedSessionId
        ) {
          return fullPath;
        }
      }
    }
  }

  return '';
}

module.exports = {
  findCodexRolloutFile,
};
