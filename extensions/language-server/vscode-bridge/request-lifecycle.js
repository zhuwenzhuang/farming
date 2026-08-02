'use strict';

const DEFAULT_DEADLINE_MS = 8_000;
const SHUTDOWN_CODE = 'VSCODE_BRIDGE_SHUTTING_DOWN';
const STALLED_CODE = 'VSCODE_BRIDGE_PROVIDER_STALLED';

class RequestLifecycleError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function stalledMessage(prefix) {
  return `${prefix} Reload the VS Code window if this persists.`;
}

function createRequestLifecycle(options = {}) {
  const deadlineMs = options.deadlineMs || DEFAULT_DEADLINE_MS;
  const schedule = options.schedule || setTimeout;
  const cancel = options.cancel || clearTimeout;
  let generation = 0;
  let disposed = false;
  const inFlight = new Map();
  const stalled = new Map();

  function clearStalled(settledGeneration) {
    stalled.delete(settledGeneration);
  }

  function state() {
    return {
      requestState: stalled.size > 0 ? 'stalled' : 'ready',
      stalledGenerations: [...stalled.keys()].sort((left, right) => left - right),
      inFlightGenerations: [...inFlight.keys()].sort((left, right) => left - right),
    };
  }

  async function run(operationFactory) {
    if (disposed) {
      throw new RequestLifecycleError('VS Code Bridge is shutting down.', SHUTDOWN_CODE, 503);
    }
    if (stalled.size > 0) {
      throw new RequestLifecycleError(stalledMessage(
        'A previous VS Code language provider request is still running.',
      ), STALLED_CODE, 503);
    }

    const requestGeneration = generation += 1;
    let operation;
    try {
      operation = Promise.resolve(operationFactory());
    } catch (error) {
      operation = Promise.reject(error);
    }

    return await new Promise((resolve, reject) => {
      let responseSettled = false;
      const timer = schedule(() => {
        inFlight.delete(requestGeneration);
        if (responseSettled) return;
        responseSettled = true;
        stalled.set(requestGeneration, operation);
        void operation.then(
          () => clearStalled(requestGeneration),
          () => clearStalled(requestGeneration),
        );
        reject(new RequestLifecycleError(stalledMessage(
          'The VS Code language provider did not finish before the Bridge deadline.',
        ), STALLED_CODE, 504));
      }, deadlineMs);

      inFlight.set(requestGeneration, {
        reject(error) {
          if (responseSettled) return;
          responseSettled = true;
          cancel(timer);
          reject(error);
        },
      });

      operation.then(value => {
        if (responseSettled) return;
        responseSettled = true;
        inFlight.delete(requestGeneration);
        cancel(timer);
        resolve(value);
      }, error => {
        if (responseSettled) return;
        responseSettled = true;
        inFlight.delete(requestGeneration);
        cancel(timer);
        reject(error);
      });
    });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    const error = new RequestLifecycleError('VS Code Bridge is shutting down.', SHUTDOWN_CODE, 503);
    for (const entry of inFlight.values()) entry.reject(error);
    inFlight.clear();
    stalled.clear();
  }

  return { dispose, run, state };
}

module.exports = {
  DEFAULT_DEADLINE_MS,
  RequestLifecycleError,
  SHUTDOWN_CODE,
  STALLED_CODE,
  createRequestLifecycle,
};
