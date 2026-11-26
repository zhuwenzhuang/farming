// Give the form and the native user message that delivers its answer one shared identity.
export function integrateCodexQuestions(source: string): string {
  const replace = (from: string, to: string) => {
    if (source.split(from).length !== 2) throw new Error(`Expected one Codex async question boundary: ${from}`);
    source = source.replace(from, to);
  };
  replace('const questions = formQuestions(message);', 'const questions = formQuestions(message);\n    const answerMessageId = globalThis.crypto.randomUUID();');
  replace('_meta: { codex: { delivery: "async" } }', '_meta: { codex: { delivery: "async" }, farming: { answerMessageId, messageIsInstructions: true } }');
  replace('this.answer(message, questions, response)', 'this.answer(message, questions, response, answerMessageId)');
  replace('async answer(message, questions, response)', 'async answer(message, questions, response, answerMessageId)');
  replace('this.client.sendReply(formatAsyncQuestionReply(replies))', 'this.client.sendReply(formatAsyncQuestionReply(replies), answerMessageId)');
  replace(`  async sendReply(text) {
    const response = await this.steering.executeOrQueueSteeringRequest({
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }]
    });`, `  async sendReply(text, answerMessageId) {
    const response = await this.steering.executeOrQueueSteeringRequest({
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }],
      clientMessageId: answerMessageId
    });`);
  return source;
}
