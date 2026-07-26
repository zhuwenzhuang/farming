const fs = require('fs');
const { atomicWriteJson } = require('./atomic-json-store');
const storageLayout = require('./storage-layout');

class RunHistoryStore {
  constructor(configDir, options = {}) {
    this.configDir = configDir;
    this.historyDir = storageLayout.historyDir(configDir);
    this.runsFile = storageLayout.runHistoryFile(configDir);
    this.normalizeTaskHistory = typeof options.normalizeTaskHistory === 'function'
      ? options.normalizeTaskHistory
      : entries => (Array.isArray(entries) ? entries.slice(0, 200) : []);
    this.writeJson = typeof options.writeJson === 'function' ? options.writeJson : atomicWriteJson;
    this.entries = null;
  }

  init({ legacyTaskHistory = [] } = {}) {
    fs.mkdirSync(this.historyDir, { recursive: true });
    const current = this.readEntries();
    const nextEntries = current.length > 0
      ? current
      : this.normalizeTaskHistory(legacyTaskHistory);
    this.writeEntries(nextEntries);
    this.entries = nextEntries;
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

  writeEntries(entries = this.ensureEntries()) {
    this.writeJson(this.runsFile, entries);
  }

  getEntries() {
    return this.ensureEntries().slice();
  }

  setEntries(entries) {
    const nextEntries = this.normalizeTaskHistory(entries);
    this.writeEntries(nextEntries);
    this.entries = nextEntries;
    return this.getEntries();
  }

  appendEntry(entry) {
    const nextEntries = this.normalizeTaskHistory([entry, ...this.ensureEntries()]);
    this.writeEntries(nextEntries);
    this.entries = nextEntries;
    return this.getEntries();
  }
}

module.exports = {
  RunHistoryStore,
};
