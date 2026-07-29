const EventEmitter = require('events');

class SessionEngine extends EventEmitter {
  /** @returns {Promise<any>} */
  async createSession(_options) {
    throw new Error('createSession() must be implemented by subclasses');
  }

  /** @returns {Promise<any>} */
  async sendInput(_sessionId, _input) {
    throw new Error('sendInput() must be implemented by subclasses');
  }

  /** @returns {Promise<any>} */
  async interruptSession(_sessionId, _input, _options = {}) {
    throw new Error('interruptSession() must be implemented by subclasses');
  }

  /** @returns {Promise<any>} */
  async resizeSession(_sessionId, _cols, _rows) {
    throw new Error('resizeSession() must be implemented by subclasses');
  }

  /** @returns {Promise<any>} */
  async clearBuffer(_sessionId) {
    throw new Error('clearBuffer() must be implemented by subclasses');
  }

  /** @returns {Promise<any>} */
  async killSession(_sessionId) {
    throw new Error('killSession() must be implemented by subclasses');
  }

  /** @returns {Promise<any>} */
  async getSessionState(_sessionId) {
    throw new Error('getSessionState() must be implemented by subclasses');
  }

  /** @returns {Promise<any>} */
  async getSessionPreview(_sessionId) {
    throw new Error('getSessionPreview() must be implemented by subclasses');
  }

  async recoverSessions(_options = {}) {
    return [];
  }

  consumeRuntimeRotation() {
    return null;
  }

  dispose() {}
}

module.exports = SessionEngine;
