import type { EventEmitter } from 'node:events';

export interface ObservationChild extends EventEmitter {
  pid?: number;
  stdout?: EventEmitter | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface ObservationOptions<Timer = NodeJS.Timeout> {
  timeoutMs?: number;
  spawnProcess?: (
    command: string,
    args: string[],
    options: { stdio: 'inherit' | ['ignore', 'pipe', 'ignore']; detached: boolean },
  ) => ObservationChild;
  signals?: EventEmitter;
  killProcess?: (pid: number, signal: NodeJS.Signals) => unknown;
  schedule?: (callback: () => void, delayMs: number) => Timer;
  unschedule?: (timer: Timer) => void;
  stderr?: (message: string) => void;
  platform?: NodeJS.Platform;
  onStdout?: (chunk: Buffer) => void;
  maxOutputBytes?: number;
}

export function isReadOnlyObservation(args: string[]): boolean;
export function observeGitHub<Timer = NodeJS.Timeout>(args: string[], options?: ObservationOptions<Timer>): Promise<number>;
