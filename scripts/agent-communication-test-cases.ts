// Independent process-level stories shared by the backend and release runners.
export const agentCommunicationTestCases = [
  ...['claude', 'codex', 'opencode', 'pi', 'qoder', 'qwen', 'agy'].map(provider => ({
    domain: provider, pattern: `^${provider}:`,
  })),
  { domain: 'disposal', pattern: '^repeated Host disposal' },
];
