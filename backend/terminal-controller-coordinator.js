const crypto = require('crypto');
const {
  DEFAULT_CONTROLLER_LEASE_TTL_MS,
  MAX_CONTROLLER_LEASE_TTL_MS,
} = require('./terminal-controller-lease');

class TerminalControllerCoordinator {
  constructor(options = {}) {
    this.agentManager = options.agentManager;
    this.serverInstanceId = options.serverInstanceId || crypto.randomUUID();
    this.leaseTtlMs = options.leaseTtlMs || DEFAULT_CONTROLLER_LEASE_TTL_MS;
    this.owners = new Map();
    this.queues = new Map();
    this.claims = new Map();
    this.leaseExpiryTimer = null;
    this.send = options.send || ((ws, message) => {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify(message));
      }
    });
  }

  scheduleLeaseExpiryCheck() {
    if (this.leaseExpiryTimer) {
      clearTimeout(this.leaseExpiryTimer);
      this.leaseExpiryTimer = null;
    }
    let nextExpiry = Infinity;
    for (const owner of this.owners.values()) {
      if (Number.isFinite(owner.expiresAt)) nextExpiry = Math.min(nextExpiry, owner.expiresAt);
    }
    if (!Number.isFinite(nextExpiry)) return;
    const delay = Math.max(0, nextExpiry - Date.now());
    this.leaseExpiryTimer = setTimeout(() => {
      this.leaseExpiryTimer = null;
      const now = Date.now();
      const expirations = [];
      for (const [agentId, owner] of this.owners.entries()) {
        if (owner.expiresAt <= now) expirations.push(this.expireOwner(agentId, owner));
      }
      void Promise.allSettled(expirations).finally(() => this.scheduleLeaseExpiryCheck());
    }, delay);
    this.leaseExpiryTimer.unref?.();
  }

  expireOwner(agentId, expectedOwner) {
    return this.enqueue(agentId, async () => {
      const owner = this.owners.get(agentId);
      if (owner !== expectedOwner || owner.expiresAt > Date.now()) return;
      await this.agentManager.releaseAgentSessionController(agentId, {
        ownerKey: owner.ownerKey,
        leaseId: owner.leaseId,
        fence: owner.fence,
        reason: 'lease-expired',
      });
      if (this.owners.get(agentId) !== owner) return;
      this.owners.delete(agentId);
      this.sendState(owner.ws, {
        agentId,
        attachmentId: owner.attachmentId,
        claimId: owner.claimId,
        status: 'expired',
        reason: 'lease-expired',
      });
    });
  }

  ownerKey(ws, attachmentId) {
    return `${this.serverInstanceId}:${ws.connectionId || ''}:${attachmentId}`;
  }

  claimKey(ws, agentId, attachmentId) {
    return `${ws.connectionId || ''}\0${agentId}\0${attachmentId}`;
  }

  enqueue(agentId, operation) {
    const previous = this.queues.get(agentId) || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.queues.set(agentId, next);
    const cleanup = () => {
      if (this.queues.get(agentId) === next) {
        this.queues.delete(agentId);
      }
    };
    next.then(cleanup, cleanup);
    return next;
  }

  sendState(ws, payload) {
    this.send(ws, {
      type: 'terminal-controller',
      ...payload,
    });
  }

  publicOwnerState(owner, status = 'observer', extra = {}) {
    const publicExtra = extra;
    const state = {
      agentId: owner.agentId,
      attachmentId: publicExtra.attachmentId || owner.attachmentId,
      claimId: publicExtra.claimId || owner.claimId,
      status,
      leaseId: status === 'owner' || status === 'resize-committed' ? owner.leaseId : undefined,
      fence: status === 'owner' || status === 'resize-committed' ? owner.fence : undefined,
      expiresAt: owner.expiresAt,
      ...publicExtra,
    };
    return state;
  }

  isCurrentOwner(owner, ws, attachmentId, leaseId, fence) {
    return Boolean(owner)
      && owner.ws === ws
      && owner.attachmentId === attachmentId
      && owner.leaseId === leaseId
      && owner.fence === fence;
  }

  terminalControlForOwner(owner, ttlMs = this.leaseTtlMs) {
    return {
      ownerKey: owner.ownerKey,
      leaseId: owner.leaseId,
      fence: owner.fence,
      expectedRuntimeEpoch: owner.claimedRuntimeEpoch,
      ttlMs,
    };
  }

  authorizeHttpMutation(agentId, controller) {
    const owner = this.owners.get(agentId);
    if (!owner) {
      return this.agentManager.agentRequiresTerminalController?.(agentId) === true
        ? { allowed: false, reason: 'unowned' }
        : { allowed: true, terminalControl: null };
    }
    if (
      !controller ||
      owner.attachmentId !== controller.attachmentId ||
      owner.leaseId !== controller.leaseId ||
      owner.fence !== controller.fence ||
      owner.claimedRuntimeEpoch !== controller.expectedRuntimeEpoch
    ) {
      return { allowed: false, reason: 'terminal-controlled-by-another-window' };
    }
    return {
      allowed: true,
      terminalControl: this.terminalControlForOwner(owner),
    };
  }

  runOwnedMutation(agentId, controller, operation) {
    return this.enqueue(agentId, async () => {
      const owner = this.owners.get(agentId);
      if (!owner) return { status: 'rejected', reason: 'unowned' };
      if (
        !controller ||
        owner.attachmentId !== controller.attachmentId ||
        owner.leaseId !== controller.leaseId ||
        owner.fence !== controller.fence ||
        owner.claimedRuntimeEpoch !== controller.expectedRuntimeEpoch
      ) {
        return { status: 'rejected', reason: 'terminal-controlled-by-another-window' };
      }
      // A profile mutation can legitimately span several rendered Codex menus.
      // Keep the already-admitted lease alive while this queue entry pins the
      // owner, so the host cannot expire the fence halfway through the picker
      // and reject the best-effort Escape cleanup. Takeovers and ordinary
      // mutations remain queued behind the complete operation.
      const operationTtlMs = MAX_CONTROLLER_LEASE_TTL_MS;
      let renewalInFlight = null;
      let renewalFailure = null;
      const renewPinnedOwner = async () => {
        if (renewalInFlight) return renewalInFlight;
        renewalInFlight = (async () => {
          const current = this.owners.get(agentId);
          if (current !== owner) throw new Error('Terminal control changed during the owned operation');
          const result = await this.agentManager.renewAgentSessionController(agentId, {
            ...this.terminalControlForOwner(owner, operationTtlMs),
            ttlMs: operationTtlMs,
          });
          if (!result || result.status !== 'owner') {
            throw new Error(`Terminal control could not be pinned: ${result?.reason || 'renew-failed'}`);
          }
          owner.expiresAt = result.expiresAt;
          this.scheduleLeaseExpiryCheck();
        })().catch(error => {
          renewalFailure = error;
          throw error;
        }).finally(() => {
          renewalInFlight = null;
        });
        return renewalInFlight;
      };

      await renewPinnedOwner();
      const keepAliveIntervalMs = Math.max(1000, Math.floor(operationTtlMs / 3));
      const keepAlive = setInterval(() => {
        void renewPinnedOwner().catch(() => {});
      }, keepAliveIntervalMs);
      keepAlive.unref?.();
      try {
        const value = await operation({
          terminalControl: this.terminalControlForOwner(owner, operationTtlMs),
          expectedRuntimeEpoch: owner.claimedRuntimeEpoch,
        });
        if (renewalInFlight) await renewalInFlight;
        if (renewalFailure) throw renewalFailure;
        return { status: 'committed', value };
      } finally {
        clearInterval(keepAlive);
      }
    });
  }

  runSystemMutation(agentId, operation, options = {}) {
    return this.enqueue(agentId, async () => {
      const owner = this.owners.get(agentId);
      if (owner && options.allowWhileControlled !== true) {
        return { status: 'rejected', reason: 'terminal-controlled-by-browser' };
      }
      const expectedRuntimeEpoch = owner
        ? owner.claimedRuntimeEpoch
        : (typeof options.expectedRuntimeEpoch === 'string' ? options.expectedRuntimeEpoch : '');
      if (!expectedRuntimeEpoch) {
        return { status: 'rejected', reason: 'runtime-not-ready' };
      }
      if (
        owner &&
        typeof options.expectedRuntimeEpoch === 'string' &&
        options.expectedRuntimeEpoch &&
        options.expectedRuntimeEpoch !== owner.claimedRuntimeEpoch
      ) {
        return { status: 'rejected', reason: 'runtime-epoch-mismatch' };
      }
      const terminalControl = owner
        ? this.terminalControlForOwner(owner)
        : { kind: 'system', expectedRuntimeEpoch };
      return operation({ terminalControl, expectedRuntimeEpoch });
    });
  }

  async retireOwner(agentId, owner, reason) {
    if (!owner || this.owners.get(agentId) !== owner) return;
    await this.agentManager.releaseAgentSessionController(agentId, {
      ownerKey: owner.ownerKey,
      leaseId: owner.leaseId,
      fence: owner.fence,
      reason,
    });
    if (this.owners.get(agentId) === owner) this.owners.delete(agentId);
    this.scheduleLeaseExpiryCheck();
  }

  claim(ws, data) {
    const agentId = typeof data.agentId === 'string' ? data.agentId : '';
    const attachmentId = typeof data.attachmentId === 'string' ? data.attachmentId : '';
    const claimId = typeof data.claimId === 'string' ? data.claimId : '';
    const mode = data.mode === 'interactive' ? 'interactive' : 'passive';
    if (!agentId || !attachmentId || !claimId) return Promise.resolve();

    return this.enqueue(agentId, async () => {
      const existing = this.owners.get(agentId);
      const claimKey = this.claimKey(ws, agentId, attachmentId);
      if (this.claims.get(claimKey) === claimId) {
        if (existing && existing.ws === ws && existing.attachmentId === attachmentId) {
          this.sendState(ws, this.publicOwnerState(existing, 'owner', {
            claimId,
          }));
        } else if (existing) {
          this.sendState(ws, this.publicOwnerState(existing, 'observer', {
            attachmentId,
            claimId,
            reason: 'superseded-claim',
          }));
        } else {
          this.sendState(ws, {
            agentId,
            attachmentId,
            claimId,
            status: 'unowned',
            reason: 'superseded-claim',
          });
        }
        return;
      }
      this.claims.set(claimKey, claimId);
      if (
        existing &&
        existing.expiresAt > Date.now() &&
        (existing.ws !== ws || existing.attachmentId !== attachmentId) &&
        mode !== 'interactive'
      ) {
        this.sendState(ws, this.publicOwnerState(existing, 'observer', {
          attachmentId,
          claimId,
        }));
        return;
      }

      const ownerKey = this.ownerKey(ws, attachmentId);
      const result = await this.agentManager.claimAgentSessionController(agentId, {
        ownerKey,
        claimId,
        ttlMs: this.leaseTtlMs,
        expectedRuntimeEpoch: typeof data.expectedRuntimeEpoch === 'string'
          ? data.expectedRuntimeEpoch
          : '',
      });
      if (!result || result.status !== 'owner') {
        this.sendState(ws, {
          agentId,
          attachmentId,
          claimId,
          status: 'rejected',
          reason: result?.reason || 'claim-failed',
        });
        return;
      }

      const owner = {
        agentId,
        attachmentId,
        claimId,
        ownerKey,
        ws,
        leaseId: result.leaseId,
        fence: result.fence,
        expiresAt: result.expiresAt,
        claimedRuntimeEpoch: result.claimedRuntimeEpoch,
      };
      this.owners.set(agentId, owner);
      this.scheduleLeaseExpiryCheck();
      if (existing && (existing.ws !== ws || existing.attachmentId !== attachmentId)) {
        this.sendState(existing.ws, this.publicOwnerState(owner, 'revoked', {
          attachmentId: existing.attachmentId,
          claimId: existing.claimId,
          reason: 'interactive-takeover',
        }));
      }
      this.sendState(ws, this.publicOwnerState(owner, 'owner'));
    });
  }

  renew(ws, data) {
    const agentId = typeof data.agentId === 'string' ? data.agentId : '';
    const attachmentId = typeof data.attachmentId === 'string' ? data.attachmentId : '';
    if (!agentId || !attachmentId) return Promise.resolve();

    return this.enqueue(agentId, async () => {
      const owner = this.owners.get(agentId);
      if (!this.isCurrentOwner(owner, ws, attachmentId, data.leaseId, data.fence)) {
        if (owner) {
          this.sendState(ws, this.publicOwnerState(owner, 'observer', { attachmentId, reason: 'stale-lease' }));
        }
        return;
      }
      const result = await this.agentManager.renewAgentSessionController(agentId, {
        ownerKey: owner.ownerKey,
        leaseId: owner.leaseId,
        fence: owner.fence,
        expectedRuntimeEpoch: owner.claimedRuntimeEpoch,
        ttlMs: this.leaseTtlMs,
      });
      if (!result || result.status !== 'owner') {
        await this.retireOwner(agentId, owner, result?.reason || 'renew-failed');
        this.sendState(ws, {
          agentId,
          attachmentId,
          claimId: owner.claimId,
          status: 'expired',
          reason: result?.reason || 'renew-failed',
        });
        return;
      }
      Object.assign(owner, {
        expiresAt: result.expiresAt,
      });
      this.scheduleLeaseExpiryCheck();
      this.sendState(ws, this.publicOwnerState(owner, 'owner', { renewed: true }));
    });
  }

  rendererReady(ws, data) {
    const agentId = typeof data.agentId === 'string' ? data.agentId : '';
    const attachmentId = typeof data.attachmentId === 'string' ? data.attachmentId : '';
    if (!agentId || !attachmentId) return Promise.resolve();

    return this.enqueue(agentId, async () => {
      const owner = this.owners.get(agentId);
      if (!this.isCurrentOwner(owner, ws, attachmentId, data.leaseId, data.fence)) {
        if (owner) {
          this.sendState(ws, this.publicOwnerState(owner, 'observer', {
            attachmentId,
            reason: 'stale-lease',
          }));
        }
        return;
      }
      const result = await this.agentManager.activateAgentSessionRenderer(agentId, {
        ownerKey: owner.ownerKey,
        leaseId: owner.leaseId,
        fence: owner.fence,
        expectedRuntimeEpoch: data.expectedRuntimeEpoch,
        ttlMs: this.leaseTtlMs,
      });
      if (!result || result.status !== 'renderer-ready-accepted') {
        await this.retireOwner(agentId, owner, result?.reason || 'renderer-ready-failed');
        this.sendState(ws, this.publicOwnerState(owner, 'rejected', {
          attachmentId,
          reason: result?.reason || 'renderer-ready-failed',
        }));
      }
    });
  }

  release(ws, data, reason = 'released') {
    const agentId = typeof data.agentId === 'string' ? data.agentId : '';
    const attachmentId = typeof data.attachmentId === 'string' ? data.attachmentId : '';
    if (!agentId || !attachmentId) return Promise.resolve();

    return this.enqueue(agentId, async () => {
      const owner = this.owners.get(agentId);
      if (!this.isCurrentOwner(owner, ws, attachmentId, data.leaseId, data.fence)) return;
      await this.agentManager.releaseAgentSessionController(agentId, {
        ownerKey: owner.ownerKey,
        leaseId: owner.leaseId,
        fence: owner.fence,
        reason,
      });
      if (this.owners.get(agentId) === owner) {
        this.owners.delete(agentId);
      }
      this.scheduleLeaseExpiryCheck();
      this.sendState(ws, {
        agentId,
        attachmentId,
        claimId: owner.claimId,
        status: 'unowned',
        reason,
      });
    });
  }

  resize(ws, data) {
    const agentId = typeof data.agentId === 'string' ? data.agentId : '';
    const attachmentId = typeof data.attachmentId === 'string' ? data.attachmentId : '';
    if (!agentId || !attachmentId) return Promise.resolve();

    return this.enqueue(agentId, async () => {
      const owner = this.owners.get(agentId);
      if (!this.isCurrentOwner(owner, ws, attachmentId, data.leaseId, data.fence)) {
        if (owner) {
          this.sendState(ws, this.publicOwnerState(owner, 'observer', {
            attachmentId,
            reason: 'stale-lease',
            requestSeq: data.requestSeq,
          }));
        } else {
          this.sendState(ws, {
            agentId,
            attachmentId,
            status: 'resize-rejected',
            reason: 'unowned',
            requestSeq: data.requestSeq,
          });
        }
        return;
      }

      const result = await this.agentManager.resizeAgentSession(agentId, data.cols, data.rows, {
        ownerKey: owner.ownerKey,
        leaseId: owner.leaseId,
        fence: owner.fence,
        requestSeq: data.requestSeq,
        expectedRuntimeEpoch: data.expectedRuntimeEpoch,
        ttlMs: this.leaseTtlMs,
      });
      if (!result || result.status !== 'resize-committed') {
        await this.retireOwner(agentId, owner, result?.reason || 'resize-failed');
        this.sendState(ws, {
          agentId,
          attachmentId,
          claimId: owner.claimId,
          status: 'resize-rejected',
          reason: result?.reason || 'resize-failed',
          requestSeq: data.requestSeq,
        });
        return;
      }

      Object.assign(owner, {
        expiresAt: result.expiresAt,
        resizeRequestSeq: result.requestSeq,
      });
      const resizeState = {
        requestSeq: result.requestSeq,
        unchanged: result.unchanged === true,
        duplicate: result.duplicate === true,
      };
      if (result.unchanged === true) {
        this.sendState(ws, this.publicOwnerState(owner, 'resize-committed', resizeState));
        return;
      }
      this.sendState(ws, this.publicOwnerState(owner, 'resize-committed', resizeState));
    });
  }

  input(ws, data, inputParts) {
    const agentId = typeof data.agentId === 'string' ? data.agentId : '';
    const attachmentId = typeof data.attachmentId === 'string' ? data.attachmentId : '';
    if (!agentId || !attachmentId) {
      return Promise.resolve();
    }

    return this.enqueue(agentId, async () => {
      const owner = this.owners.get(agentId);
      if (!this.isCurrentOwner(owner, ws, attachmentId, data.leaseId, data.fence)) {
        if (owner) {
          this.sendState(ws, this.publicOwnerState(owner, 'observer', {
            attachmentId,
            reason: 'stale-lease',
          }));
        } else {
          this.sendState(ws, {
            agentId,
            attachmentId,
            status: 'unowned',
            reason: 'unowned',
          });
        }
        return;
      }
      if (!data.expectedRuntimeEpoch || data.expectedRuntimeEpoch !== owner.claimedRuntimeEpoch) {
        this.sendState(ws, {
          agentId,
          attachmentId,
          status: 'rejected',
          reason: 'runtime-epoch-mismatch',
        });
        return;
      }

      try {
        const result = await this.agentManager.sendInput(agentId, inputParts, {
          terminalControl: this.terminalControlForOwner(owner),
        });
        if (result?.status === 'input-rejected') {
          await this.retireOwner(agentId, owner, result.reason || 'input-rejected');
          this.sendState(ws, {
            agentId,
            attachmentId,
            status: 'rejected',
            reason: result.reason || 'input-rejected',
          });
        }
      } catch (error) {
        this.send(ws, {
          type: 'error',
          message: `Terminal input failed and was not retried: ${
            error instanceof Error ? error.message : 'transport error'
          }`,
        });
      }
    });
  }

  interrupt(ws, data) {
    const agentId = typeof data.agentId === 'string' ? data.agentId : '';
    if (!agentId) return Promise.resolve();

    return this.enqueue(agentId, async () => {
      const owner = this.owners.get(agentId);
      if (!owner) {
        if (this.agentManager.agentRequiresTerminalController?.(agentId) === true) {
          this.sendState(ws, {
            agentId,
            attachmentId: data.attachmentId,
            status: 'rejected',
            reason: 'unowned',
          });
          return;
        }
        await this.agentManager.interruptAgent(agentId);
        return;
      }
      if (!this.isCurrentOwner(owner, ws, data.attachmentId, data.leaseId, data.fence)) {
        this.sendState(ws, this.publicOwnerState(owner, 'observer', {
          attachmentId: data.attachmentId,
          reason: 'stale-lease',
        }));
        return;
      }
      if (!data.expectedRuntimeEpoch || data.expectedRuntimeEpoch !== owner.claimedRuntimeEpoch) {
        this.sendState(ws, {
          agentId,
          attachmentId: owner.attachmentId,
          status: 'rejected',
          reason: 'runtime-epoch-mismatch',
        });
        return;
      }
      const result = await this.agentManager.interruptAgent(agentId, {
        terminalControl: this.terminalControlForOwner(owner),
      });
      if (result?.status === 'input-rejected') {
        await this.retireOwner(agentId, owner, result.reason || 'interrupt-rejected');
        this.sendState(ws, {
          agentId,
          attachmentId: owner.attachmentId,
          status: 'rejected',
          reason: result.reason || 'interrupt-rejected',
        });
      }
    });
  }

  clear(ws, data) {
    const agentId = typeof data.agentId === 'string' ? data.agentId : '';
    const attachmentId = typeof data.attachmentId === 'string' ? data.attachmentId : '';
    if (!agentId || !attachmentId) return Promise.resolve();

    return this.enqueue(agentId, async () => {
      const owner = this.owners.get(agentId);
      if (!this.isCurrentOwner(owner, ws, attachmentId, data.leaseId, data.fence)) {
        if (owner) {
          this.sendState(ws, this.publicOwnerState(owner, 'observer', {
            attachmentId,
            reason: 'stale-lease',
          }));
        } else {
          this.sendState(ws, {
            agentId,
            attachmentId,
            status: 'unowned',
            reason: 'unowned',
          });
        }
        return;
      }
      if (!data.expectedRuntimeEpoch || data.expectedRuntimeEpoch !== owner.claimedRuntimeEpoch) {
        this.sendState(ws, {
          agentId,
          attachmentId,
          status: 'rejected',
          reason: 'runtime-epoch-mismatch',
        });
        return;
      }

      const result = await this.agentManager.clearAgentSessionBuffer(agentId, {
        ownerKey: owner.ownerKey,
        leaseId: owner.leaseId,
        fence: owner.fence,
        expectedRuntimeEpoch: data.expectedRuntimeEpoch,
        ttlMs: this.leaseTtlMs,
      });
      if (!result?.cleared) {
        await this.retireOwner(agentId, owner, result?.reason || 'clear-failed');
        this.sendState(ws, {
          agentId,
          attachmentId,
          claimId: owner.claimId,
          status: 'rejected',
          reason: result?.reason || result?.error || 'clear-failed',
        });
        return;
      }
      Object.assign(owner, {
        expiresAt: result.expiresAt ?? owner.expiresAt,
      });
    });
  }

  acknowledgeOutput(ws, data) {
    const agentId = typeof data.agentId === 'string' ? data.agentId : '';
    const attachmentId = typeof data.attachmentId === 'string' ? data.attachmentId : '';
    const charCount = Math.floor(Number(data.charCount));
    if (!agentId || !attachmentId || !Number.isFinite(charCount) || charCount <= 0) {
      return Promise.resolve();
    }

    return this.enqueue(agentId, async () => {
      const owner = this.owners.get(agentId);
      if (!this.isCurrentOwner(owner, ws, attachmentId, data.leaseId, data.fence)) {
        if (owner) {
          this.sendState(ws, this.publicOwnerState(owner, 'observer', {
            attachmentId,
            reason: 'stale-lease',
          }));
        }
        return;
      }
      const result = await this.agentManager.acknowledgeAgentSessionOutput(
        agentId,
        charCount,
        {
          ownerKey: owner.ownerKey,
          leaseId: owner.leaseId,
          fence: owner.fence,
          expectedRuntimeEpoch: data.expectedRuntimeEpoch,
          ttlMs: this.leaseTtlMs,
        },
      );
      if (!result || result.status !== 'output-ack-accepted') {
        await this.retireOwner(agentId, owner, result?.reason || 'output-ack-failed');
        this.sendState(ws, {
          agentId,
          attachmentId,
          claimId: owner.claimId,
          status: result?.reason === 'stale-lease' || result?.reason === 'unowned'
            ? 'observer'
            : 'rejected',
          reason: result?.reason || 'output-ack-failed',
        });
        return;
      }
      owner.expiresAt = result.expiresAt ?? owner.expiresAt;
    });
  }

  checkpointApplied(ws, data) {
    const agentId = typeof data.agentId === 'string' ? data.agentId : '';
    const attachmentId = typeof data.attachmentId === 'string' ? data.attachmentId : '';
    const outputSeq = Math.floor(Number(data.outputSeq));
    const stateRevision = Math.floor(Number(data.stateRevision));
    if (
      !agentId ||
      !attachmentId ||
      !Number.isFinite(outputSeq) ||
      !Number.isFinite(stateRevision) ||
      outputSeq < 0 ||
      stateRevision < 0
    ) return Promise.resolve();

    return this.enqueue(agentId, async () => {
      const owner = this.owners.get(agentId);
      if (!this.isCurrentOwner(owner, ws, attachmentId, data.leaseId, data.fence)) {
        if (owner) {
          this.sendState(ws, this.publicOwnerState(owner, 'observer', {
            attachmentId,
            reason: 'stale-lease',
          }));
        }
        return;
      }
      const result = await this.agentManager.acknowledgeAgentSessionCheckpoint(
        agentId,
        outputSeq,
        stateRevision,
        {
          ownerKey: owner.ownerKey,
          leaseId: owner.leaseId,
          fence: owner.fence,
          expectedRuntimeEpoch: data.expectedRuntimeEpoch,
          ttlMs: this.leaseTtlMs,
        },
      );
      if (!result || result.status !== 'checkpoint-applied-accepted') {
        await this.retireOwner(agentId, owner, result?.reason || 'checkpoint-applied-failed');
        this.sendState(ws, {
          agentId,
          attachmentId,
          claimId: owner.claimId,
          status: result?.reason === 'stale-lease' || result?.reason === 'unowned'
            ? 'observer'
            : 'rejected',
          reason: result?.reason || 'checkpoint-applied-failed',
        });
        return;
      }
      owner.expiresAt = result.expiresAt ?? owner.expiresAt;
    });
  }

  releaseAllForSocket(ws) {
    const releases = [];
    for (const owner of this.owners.values()) {
      if (owner.ws !== ws) continue;
      releases.push(this.release(ws, {
        agentId: owner.agentId,
        attachmentId: owner.attachmentId,
        leaseId: owner.leaseId,
        fence: owner.fence,
      }, 'socket-closed'));
    }
    const connectionPrefix = `${ws.connectionId || ''}\0`;
    for (const key of this.claims.keys()) {
      if (key.startsWith(connectionPrefix)) this.claims.delete(key);
    }
    return Promise.allSettled(releases);
  }
}

module.exports = TerminalControllerCoordinator;
