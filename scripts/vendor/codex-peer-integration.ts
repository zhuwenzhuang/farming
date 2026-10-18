// Version-locked insertion points. A changed upstream boundary must be reviewed.
export function integrateCodexPeerMessages(source: string): string {
  source = source.replace(/^#![^\n]*\n/, '');
  const replace = (from: string, to: string) => {
    if (source.split(from).length !== 2) throw new Error(`Expected one Codex peer boundary: ${from.slice(0, 100)}`);
    source = source.replace(from, to);
  };
  // Reuse history's content conversion for live receiver-owned input. These
  // messages may have no sender metadata; visibility must not depend on it.
  replace('      await promptClient.subscribeToSessionEvents(', `      promptEventHandler.farmingUserMessageUpdates = item => this.createUserMessageUpdates(item);
      await promptClient.subscribeToSessionEvents(`);
  replace('    if (ignoredBySubagents) return;', `    if (ignoredBySubagents) return;
    if (notification.method === "item/completed" && notification.params.item.type === "userMessage") {
      const item = notification.params.item;
      const chunks = await this.farmingUserMessageUpdates(item);
      await this.session.update({ sessionUpdate: "session_message", _meta: { farming: { messageRole: "user" } }, messageId: item.id,
        content: chunks.map(chunk => chunk.content) }, this.subagents.notificationSessionId(notification));
      return;
    }`);
  replace('      case "rawResponseItem/completed":\n', '');
  replace('      // ignored events\n', '      case "rawResponseItem/completed":\n        return farmingCodexPeerUpdate(notification.params.item, notification.params.farmingReceiptTimestamp);\n      // ignored events\n');
  replace('return await this.sendRequest({ method: "thread/start", params });', 'return await this.sendRequest({ method: "thread/start", params: { ...params, experimentalRawEvents: true } });');
  replace('          await promptEventHandler.handleNotification(event);', `          await farmingSyncCodexPeerReceipts(sessionState, event, promptClient.codexClient,
            receipt => promptEventHandler.handleNotification(receipt));
          await promptEventHandler.handleNotification(event);`);
  replace('      thread,\n      history,\n', '      thread,\n      history: farmingMergePeerHistory(history, await farmingCodexPeerHistory(thread)),\n');
  replace('return turn ? oneItemPage(turn.items) : null;', 'return turn ? farmingMergePeerHistory(oneItemPage(turn.items), await farmingCodexPeerHistory(legacy.thread, new Set([turn.id]))) : null;');
  replace('if (turn) return this.codexClient.threadItemPages(sessionId, { turnId: turn.id });', 'if (turn) return farmingMergePeerHistory(this.codexClient.threadItemPages(sessionId, { turnId: turn.id }), await farmingCodexPeerHistory(metadata.thread, new Set([turn.id])));');
  replace('  async createHistoryUpdates(item, sessionState) {\n', '  async createHistoryUpdates(item, sessionState) {\n    if (item.type === "farmingPeerMessage") return [item.update];\n');
  return source;
}
