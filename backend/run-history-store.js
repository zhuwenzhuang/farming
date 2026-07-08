const fs = require('fs');
const path = require('path');
const storageLayout = require('./storage-layout');

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmpFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(value, null, 2));
  fs.renameSync(tmpFile, file);
}

class RunHistoryStore {
  constructor(configDir, options = {}) {
    this.configDir = configDir;
    this.historyDir = storageLayout.historyDir(configDir);
    this.runsFile = storageLayout.runHistoryFile(configDir);
    this.normalizeTaskHistory = typeof options.normalizeTaskHistory === 'function'
      ? options.normalizeTaskHistory
      : entries => (Array.isArray(entries) ? entries.slice(0, 200) : []);
    this.entries = null;
  }

  init({ legacyTaskHistory = [] } = {}) {
    fs.mkdirSync(this.historyDir, { recursive: true });
    const current = this.readEntries();
    this.entries = current.length > 0
      ? current
      : this.normalizeTaskHistory(legacyTaskHistory);
    this.writeEntries();
  }

  readEntries() {
    try {
      if (!fs.existsSync(this.runsFile)) return [];
      return this.normalizeTaskHistory(JSON.parse(fs.readFileSync(this.runsFile, 'utf8')));
    } catch (error) {
      console.warn('Failed to read Farming run history:', error && (error.message || error));
      return [];
    }
  }

  ensureEntries() {
    if (!this.entries) this.init();
    return this.entries;
  }

  writeEntries() {
    atomicWriteJson(this.runsFile, this.ensureEntries());
  }

  getEntries() {
    return this.ensureEntries().slice();
  }

  setEntries(entries) {
    this.entries = this.normalizeTaskHistory(entries);
    this.writeEntries();
    return this.getEntries();
  }

  appendEntry(entry) {
    this.entries = this.normalizeTaskHistory([entry, ...this.ensureEntries()]);
    this.writeEntries();
    return this.getEntries();
  }
}

module.exports = {
  RunHistoryStore,
};
