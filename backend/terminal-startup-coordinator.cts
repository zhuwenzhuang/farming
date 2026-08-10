const fs = require('fs');
const path = require('path');

import type { ProviderTerminalStartupPolicy } from './provider-adapters.cjs';

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_READY_POLL_MS = 50;
const DEFAULT_OUTPUT_LIMIT = 64 * 1024;

interface TerminalStartupSnapshot {
  engineStatus?: unknown;
  output?: unknown;
  previewText?: unknown;
  status?: unknown;
}

interface TerminalStartupCoordinatorOptions {
  outputLimit?: number;
  readyPollMs?: number;
  readyTimeoutMs?: number;
}

interface TerminalStartupRequest {
  agentId: string;
  observe: () => TerminalStartupSnapshot | null | undefined;
  policy: ProviderTerminalStartupPolicy;
  resourceKey: string;
  start: () => Promise<void> | void;
}

function positiveInteger(value: unknown, fallback: number) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function canonicalResourceKey(value: unknown): string {
  const resolved = path.resolve(String(value || '').trim() || '.');
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Owns ordered Terminal startup for providers that opt into the adapter policy.
 * One operation runs per exact canonical resource key; unrelated resources run
 * independently. Captured output, readiness, timeout, and cleanup form one
 * bounded operation and are released on every terminal path.
 */
class TerminalStartupCoordinator {
  readonly #output = new Map<string, string>();
  readonly #queues = new Map<string, Promise<void>>();
  readonly #outputLimit: number;
  readonly #readyPollMs: number;
  readonly #readyTimeoutMs: number;

  constructor(options: TerminalStartupCoordinatorOptions = {}) {
    this.#outputLimit = positiveInteger(options.outputLimit, DEFAULT_OUTPUT_LIMIT);
    this.#readyPollMs = positiveInteger(options.readyPollMs, DEFAULT_READY_POLL_MS);
    this.#readyTimeoutMs = positiveInteger(options.readyTimeoutMs, DEFAULT_READY_TIMEOUT_MS);
  }

  appendOutput(agentId: string, data: unknown): boolean {
    if (!this.#output.has(agentId)) return false;
    const output = `${this.#output.get(agentId) || ''}${String(data || '')}`;
    this.#output.set(agentId, output.slice(-this.#outputLimit));
    return true;
  }

  async run({ agentId, observe, policy, resourceKey, start }: TerminalStartupRequest): Promise<void> {
    const key = canonicalResourceKey(resourceKey);
    const previous = this.#queues.get(key) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      this.#output.set(agentId, '');
      try {
        await start();
        await this.#waitUntilReady(agentId, observe, policy);
      } finally {
        this.#output.delete(agentId);
      }
    });
    this.#queues.set(key, operation);
    try {
      await operation;
    } finally {
      if (this.#queues.get(key) === operation) this.#queues.delete(key);
    }
  }

  dispose(): void {
    this.#output.clear();
    this.#queues.clear();
  }

  async #waitUntilReady(
    agentId: string,
    observe: TerminalStartupRequest['observe'],
    policy: ProviderTerminalStartupPolicy,
  ): Promise<void> {
    const deadline = Date.now() + this.#readyTimeoutMs;
    while (Date.now() <= deadline) {
      const snapshot = observe();
      if (!snapshot) throw new Error(`Terminal ${agentId} disappeared during startup`);
      if (
        ['dead', 'stopped'].includes(String(snapshot.status || ''))
        || snapshot.engineStatus === 'exited'
      ) {
        const detail = String(snapshot.previewText || snapshot.output || '').trim();
        throw new Error(detail || `Terminal ${agentId} exited during startup`);
      }
      const output = this.#output.get(agentId) || '';
      if (
        policy.readiness.kind === 'output-includes'
        && output.includes(policy.readiness.value)
      ) {
        return;
      }
      await new Promise<void>(resolve => setTimeout(resolve, this.#readyPollMs));
    }
    throw new Error(`Terminal ${agentId} did not become ready within ${this.#readyTimeoutMs}ms`);
  }
}

export {
  TerminalStartupCoordinator,
  canonicalResourceKey,
  type TerminalStartupCoordinatorOptions,
  type TerminalStartupRequest,
  type TerminalStartupSnapshot,
};
