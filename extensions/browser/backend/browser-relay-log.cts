type RelayLogger = {
  child(name: string): RelayLogger;
  info(message: string): void;
  warn(message: string): void;
};

function createSubsystemLogger(subsystem: string): RelayLogger {
  const prefix = `[${subsystem}]`;
  return {
    child(name) {
      return createSubsystemLogger(`${subsystem}:${name}`);
    },
    info(message) {
      console.info(prefix, message);
    },
    warn(message) {
      console.warn(prefix, message);
    },
  };
}

export { createSubsystemLogger };
