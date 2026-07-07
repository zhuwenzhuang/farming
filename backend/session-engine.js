const EventEmitter = require('events');

class SessionEngine extends EventEmitter {
  async createSession(_options) {
    throw new Error('createSession() must be implemented by subclasses');
  }

  async sendInput(_sessionId, _input) {
    throw new Error('sendInput() must be implemented by subclasses');
  }

  async interruptSession(_sessionId, _input) {
    throw new Error('interruptSession() must be implemented by subclasses');
  }

  async resizeSession(_sessionId, _cols, _rows) {
    throw new Error('resizeSession() must be implemented by subclasses');
  }

  async clearBuffer(_sessionId) {
    throw new Error('clearBuffer() must be implemented by subclasses');
  }

  async killSession(_sessionId) {
    throw new Error('killSession() must be implemented by subclasses');
  }

  async getSessionState(_sessionId) {
    throw new Error('getSessionState() must be implemented by subclasses');
  }

  async getSessionPreview(_sessionId) {
    throw new Error('getSessionPreview() must be implemented by subclasses');
  }

  dispose() {}
}

module.exports = SessionEngine;
