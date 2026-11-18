// Give the form and the native user message that delivers its answer one shared identity.
export function integrateCodexQuestions(source: string): string {
  const replace = (from: string, to: string) => {
    if (source.split(from).length !== 2) throw new Error(`Expected one Codex async question boundary: ${from}`);
    source = source.replace(from, to);
  };
  replace('const questions = formQuestions(message);', 'const questions = formQuestions(message);\n    const answerMessageId = randomUUID4();');
  replace('_meta: { codex: { delivery: "async" } }', '_meta: { codex: { delivery: "async" }, farming: { answerMessageId, messageIsInstructions: true } }');
  replace('this.answer(turnId, message, questions, response)', 'this.answer(turnId, message, questions, response, answerMessageId)');
  replace('async answer(turnId, message, questions, response)', 'async answer(turnId, message, questions, response, answerMessageId)');
  replace('this.client.steer(turnId, formatAsyncQuestionReply(replies))', 'this.client.steer(turnId, formatAsyncQuestionReply(replies), answerMessageId)');
  replace('async steer(turnId, text)', 'async steer(turnId, text, answerMessageId)');
  replace('clientUserMessageId: randomUUID4()', 'clientUserMessageId: answerMessageId');
  return source;
}
