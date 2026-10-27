// A native child is a conversation, not a single turn. Keep its ACP identity
// stable when it wakes again, and fence late output to the current native turn.
export function integrateCodexSubagentTurns(source: string): string {
  const start = source.indexOf('var CodexSubagentEventRouter = class ');
  const end = source.indexOf('\nfunction terminalStateOf(', start);
  if (start < 0 || end < 0) throw new Error('Expected Codex subagent router boundary');
  let router = source.slice(start, end);
  const replace = (from: string, to: string) => {
    if (router.split(from).length !== 2) throw new Error(`Expected one child turn boundary: ${from.slice(0, 100)}`);
    router = router.replace(from, to);
  };
  replace('  children = /* @__PURE__ */ new Map();', '  children = /* @__PURE__ */ new Map();\n  nativeChildTurns = new Map();');
  replace(`    if (notification.method === "turn/started") {
      const childTurn = this.isKnownChild(notification.params.threadId);
      if (childTurn) await this.reopen(notification.params.threadId);
      return childTurn;
    }`, `    if (notification.method === "turn/started") {
      const { threadId, turn } = notification.params;
      if (!this.isKnownChild(threadId)) return false;
      if (this.nativeChildTurns.get(threadId) !== turn.id) {
        const previousTurn = this.nativeChildTurns.get(threadId);
        this.nativeChildTurns.set(threadId, turn.id);
        try {
          await this.reopen(threadId);
        } catch (error) {
          if (previousTurn === undefined) this.nativeChildTurns.delete(threadId);
          else this.nativeChildTurns.set(threadId, previousTurn);
          throw error;
        }
      }
      return true;
    }`);
  replace('      const childTurn = this.isKnownChild(notification.params.threadId);', `      const childTurn = this.isKnownChild(notification.params.threadId);
      const knownTurn = this.nativeChildTurns.get(notification.params.threadId);
      if (childTurn && knownTurn && knownTurn !== notification.params.turn.id) return true;
      if (childTurn) this.nativeChildTurns.set(notification.params.threadId, notification.params.turn.id);`);
  replace('    const ignored = typeof threadId === "string" && (', `    const knownTurn = this.nativeChildTurns.get(threadId);
    if (knownTurn && notification.params.turnId && notification.params.turnId !== knownTurn) return true;
    const ignored = typeof threadId === "string" && (`);
  replace('sessionId: `${childThreadId}:generation:2`,', 'sessionId: childThreadId,');
  const reopenStart = router.indexOf('    const previousSessionId = child.sessionId;');
  const reopenEnd = router.indexOf('\n  /** Takes a model that Codex reports', reopenStart);
  if (reopenStart < 0 || reopenEnd < 0) throw new Error('Expected child reopen boundary');
  router = router.slice(0, reopenStart) + `    const previousState = child.terminalState;
    delete child.terminalState;
    try {
      await this.session.update({
        sessionUpdate: "subagent_state_update",
        subagentSessionId: child.sessionId,
        state: "running"
      }, child.parentSessionId);
    } catch (error) {
      child.terminalState = previousState;
      throw error;
    }
    await this.reportModel(childThreadId, child.sessionId);
  }` + router.slice(reopenEnd);
  router = router.replaceAll('capabilities: {}', 'capabilities: { history: {} }')
    .replaceAll('sessionUpdate: "subagent_state_update",', 'sessionUpdate: "subagent_state_update",\n        capabilities: { history: {} },');
  source = source.slice(0, start) + router + source.slice(end);
  // History announcements use the same provider-owned child identity. The host
  // can read the complete bounded history instead of a retained first-turn view.
  const historyStart = source.indexOf('  async streamNativeThreadHistory(');
  const historyEnd = source.indexOf('  async publishThreadHistoryTitle(', historyStart);
  if (historyStart < 0 || historyEnd < 0) throw new Error('Expected child history boundary');
  return source.slice(0, historyStart)
    + source.slice(historyStart, historyEnd).replaceAll('capabilities: {}', 'capabilities: { history: {} }')
      .replace('const childSessionId = generation === 1 ? item.agentThreadId : `${item.agentThreadId}:generation:${generation}`;',
        'const childSessionId = item.agentThreadId;')
      .replaceAll('sessionUpdate: "subagent_state_update",', 'sessionUpdate: "subagent_state_update",\n        capabilities: { history: {} },')
    + source.slice(historyEnd);
}
