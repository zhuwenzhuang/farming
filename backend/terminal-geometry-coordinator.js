const crypto = require('crypto');
const { DEFAULT_GEOMETRY_LEASE_TTL_MS } = require('./terminal-geometry-control');

class TerminalGeometryCoordinator {
  constructor(options = {}) {
    this.agentManager = options.agentManager;
    this.serverInstanceId = options.serverInstanceId || crypto.randomUUID();
    this.leaseTtlMs = options.leaseTtlMs || DEFAULT_GEOMETRY_LEASE_TTL_MS;
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
      await this.agentManager.releaseAgentSessionGeometry(agentId, {
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

  async retireOwner(agentId, owner, reason) {
    if (!owner || this.owners.get(agentId) !== owner) return;
    await this.agentManager.releaseAgentSessionGeometry(agentId, {
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
      const result = await this.agentManager.claimAgentSessionGeometry(agentId, {
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
      const result = await this.agentManager.renewAgentSessionGeometry(agentId, {
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
      await this.agentManager.releaseAgentSessionGeometry(agentId, {
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
          terminalControl: {
            ownerKey: owner.ownerKey,
            leaseId: owner.leaseId,
            fence: owner.fence,
            expectedRuntimeEpoch: data.expectedRuntimeEpoch,
            ttlMs: this.leaseTtlMs,
          },
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

module.exports = TerminalGeometryCoordinator;
