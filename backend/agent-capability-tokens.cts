const crypto = require('crypto');
import { canonicalWorkspacePath } from './workspace-root-registry.cjs';

type AgentCapability = 'browser' | 'computer';

interface AgentCapabilityBinding {
  agentId: string;
  capability: AgentCapability;
  runtimeEpoch: string;
  workspace: string;
}

function agentCapabilityKey(binding: Pick<AgentCapabilityBinding, 'agentId' | 'capability'>): string {
  return JSON.stringify([
    binding.agentId,
    binding.capability,
  ]);
}

class AgentCapabilityTokens {
  private readonly bindingsByToken = new Map<string, AgentCapabilityBinding>();
  private readonly tokensByAgentCapability = new Map<string, string>();

  issue(binding: AgentCapabilityBinding): string {
    const workspace = String(binding.workspace || '').trim();
    const normalized: AgentCapabilityBinding = {
      agentId: String(binding.agentId || '').trim(),
      capability: binding.capability,
      runtimeEpoch: String(binding.runtimeEpoch || '').trim(),
      workspace: canonicalWorkspacePath(workspace),
    };
    if (
      !normalized.agentId
      || !/^[A-Za-z0-9._:-]{1,160}$/.test(normalized.runtimeEpoch)
      || !normalized.workspace
    ) {
      throw new Error('Agent capability token requires an exact Agent, runtime epoch, and workspace');
    }
    const key = agentCapabilityKey(normalized);
    const existing = this.tokensByAgentCapability.get(key);
    const existingBinding = existing ? this.bindingsByToken.get(existing) : null;
    if (
      existing
      && existingBinding?.runtimeEpoch === normalized.runtimeEpoch
      && existingBinding.workspace === normalized.workspace
    ) return existing;

    // One logical Agent owns at most one token per capability. A new ACP
    // runtime epoch or launch workspace permanently invalidates the old token
    // instead of allowing the registry to grow with runtime history.
    if (existing) this.bindingsByToken.delete(existing);

    const token = crypto.randomBytes(32).toString('base64url');
    this.tokensByAgentCapability.set(key, token);
    this.bindingsByToken.set(token, normalized);
    return token;
  }

  resolve(token: unknown, capability: AgentCapability): AgentCapabilityBinding | null {
    const binding = this.bindingsByToken.get(String(token || '').trim());
    if (!binding || binding.capability !== capability) return null;
    return { ...binding };
  }

  revokeAgent(agentId: string): void {
    const exactAgentId = String(agentId || '').trim();
    for (const [token, binding] of this.bindingsByToken) {
      if (binding.agentId !== exactAgentId) continue;
      this.bindingsByToken.delete(token);
      this.tokensByAgentCapability.delete(agentCapabilityKey(binding));
    }
  }

  activeTokenCount(): number {
    return this.bindingsByToken.size;
  }

  clear(): void {
    this.bindingsByToken.clear();
    this.tokensByAgentCapability.clear();
  }
}

export {
  AgentCapabilityTokens,
  type AgentCapability,
  type AgentCapabilityBinding,
};
