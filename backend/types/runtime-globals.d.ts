declare namespace NodeJS {
  interface Process {
    pkg?: unknown;
  }
}

// Farming attaches bounded operational metadata to Error instances at process,
// filesystem, and runtime boundaries. Declaring the reviewed keys here keeps
// checked JavaScript precise without changing the CommonJS runtime contract.
interface Error {
  code?: string | number;
  status?: number;
  signal?: NodeJS.Signals | string | null;
  uncertain?: boolean;
  cleanupUnproven?: boolean;
  socketPath?: string;
  socketPaths?: string[];
  hostLogPath?: string;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}

declare module '*extensions/browser/bin/farming-browser';
declare module '*extensions/computer/bin/farming-computer';
