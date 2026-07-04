const EventEmitter = require('events');
const TerminalScreenState = require('./terminal-screen-state');

class InlineTerminalScreenWorker extends EventEmitter {
  constructor(options = {}) {
    super();
    this.state = new TerminalScreenState(options);
    this.disposed = false;
  }

  ensureAvailable() {
    if (this.disposed) {
      throw new Error('Terminal screen worker is disposed');
    }
  }

  append(data) {
    if (this.disposed) return;
    this.state.write(String(data || '')).then((state) => {
      if (this.disposed) return;
      this.emit('preview', state);
    }, (error) => {
      if (!this.disposed) this.emit('error', error);
    });
  }

  async resize(cols, rows) {
    this.ensureAvailable();
    return this.state.resize(cols, rows);
  }

  async getState(options = {}) {
    this.ensureAvailable();
    return this.state.getState(options);
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.state.dispose();
  }
}

module.exports = InlineTerminalScreenWorker;
