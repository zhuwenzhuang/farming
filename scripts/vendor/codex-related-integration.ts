// Keep ancestry checks at the adapter boundary; replace only the history reader.
export function integrateCodexRelatedHistory(source: string): string {
  const start = '    const page = await client.threadTurnsList({ threadId: params.sessionId, limit, cursor: params.cursor || null, sortDirection: "desc" });';
  const end = '    return result;\n  }\n  async extMethod(method, params) {';
  if (source.split(start).length !== 2 || source.split(end).length !== 2) {
    throw new Error('Expected one Codex related history boundary');
  }
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  return source.slice(0, from) + `    try {
      return await farmingReadRelatedHistory({
        client, thread, params: { ...params, maxTurns: limit }, generation,
        capabilities: root.clientCapabilities,
        project: (item, projection) => this.createHistoryUpdates(item, projection),
        valid: () => {
          if (this.getSessionGeneration(params.parentSessionId) !== generation || this.sessions.get(params.parentSessionId) !== root) {
            throw new Error("Parent changed during child read. Reopen the related session.");
          }
        }
      });
    } catch (error) {
      throw RequestError.internalError(void 0, error instanceof Error ? error.message : "Subagent history could not be read");
    }
  }
  async extMethod(method, params) {` + source.slice(to + end.length);
}
