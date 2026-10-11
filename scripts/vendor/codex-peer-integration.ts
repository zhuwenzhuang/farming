// Version-locked insertion points. A changed upstream boundary must be reviewed.
export function integrateCodexPeerMessages(source: string): string {
  source = source.replace(/^#![^\n]*\n/, '');
  const replace = (from: string, to: string) => {
    if (source.split(from).length !== 2) throw new Error(`Expected one Codex peer boundary: ${from.slice(0, 100)}`);
    source = source.replace(from, to);
  };
  replace('      case "rawResponseItem/completed":\n', '');
  replace('      // ignored events\n', '      case "rawResponseItem/completed":\n        return farmingCodexPeerUpdate(notification.params.item);\n      // ignored events\n');
  replace('return await this.sendRequest({ method: "thread/start", params });', 'return await this.sendRequest({ method: "thread/start", params: { ...params, experimentalRawEvents: true } });');
  replace('return await this.sendRequest({ method: "thread/resume", params });', 'return await this.sendRequest({ method: "thread/resume", params: { ...params, experimentalRawEvents: true } });');
  replace('      thread,\n      history,\n', '      thread,\n      history: farmingMergePeerHistory(history, await farmingCodexPeerHistory(thread)),\n');
  replace('return turn ? oneItemPage(turn.items) : null;', 'return turn ? farmingMergePeerHistory(oneItemPage(turn.items), await farmingCodexPeerHistory(legacy.thread, new Set([turn.id]))) : null;');
  replace('if (turn) return this.codexClient.threadItemPages(sessionId, { turnId: turn.id });', 'if (turn) return farmingMergePeerHistory(this.codexClient.threadItemPages(sessionId, { turnId: turn.id }), await farmingCodexPeerHistory(metadata.thread, new Set([turn.id])));');
  replace('if (turn.itemsView?.type && turn.itemsView.type !== "full") {', 'if (turn.itemsView ? turn.itemsView !== "full" && turn.itemsView?.type !== "full" : turn.items.length === 0) {');
  replace('    const projection = { clientCapabilities: root.clientCapabilities, farmingHistoryUserTurns: new Set() };', '    const projection = { clientCapabilities: root.clientCapabilities, farmingHistoryUserTurns: new Set() };\n    const peers = await farmingCodexPeerHistory(thread, new Set(page.data.map(turn => turn.id)));');
  replace('      for (const item of items) {\n        updates.push(...(await this.createHistoryUpdates(item, projection) || []));\n      }', '      for await (const merged of farmingMergePeerHistory(oneItemPage(items), peers.filter(peer => peer.turnId === turn.id))) {\n        for (const item of merged) updates.push(...(await this.createHistoryUpdates(item, projection) || []));\n      }');
  replace('  async createHistoryUpdates(item, sessionState) {\n', '  async createHistoryUpdates(item, sessionState) {\n    if (item.type === "farmingPeerMessage") return [item.update];\n');
  return source;
}
