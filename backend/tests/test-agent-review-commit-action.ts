const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { codeCopyForLanguage } = require('../../src/components/code/copy.ts');

const read = (relativePath: string) => fs.readFileSync(
  path.join(__dirname, '../..', relativePath),
  'utf8',
);

const transcriptPaneSource = read('src/components/code/AgentTranscriptPane.tsx');
const agentWorkPaneSource = read('src/components/code/AgentWorkPane.tsx');
const codeMainAreaSource = read('src/components/code/CodeMainArea.tsx');
const workspaceSource = read('src/components/CodeWorkspace.tsx');
const stylesSource = read('src/styles/main.css');

assert(
  transcriptPaneSource.includes('data-testid="code-agent-transcript-review-and-commit"')
    && transcriptPaneSource.includes('<span>{copy.agentTranscriptReviewAndCommit}</span>')
    && !transcriptPaneSource.includes('<ChatBubblesGlyph />')
    && transcriptPaneSource.includes('copy.agentTranscriptReviewAndCommit')
    && agentWorkPaneSource.includes('onReviewAndCommit={onReviewAndCommit ? reviewAndCommitChat : undefined}')
    && codeMainAreaSource.includes('onReviewAndCommit={onReviewAndCommit}')
    && workspaceSource.includes('const requestAgentReviewAndCommit = useCallback')
    && workspaceSource.includes('mountedOpenAgents.find(candidate => candidate.id === agentId)')
    && workspaceSource.includes('if (!agent || !isStructuredRuntime(agent)) return')
    && workspaceSource.includes('copy.agentTranscriptReviewAndCommitPrompt')
    && workspaceSource.includes('sendComposerMessageToAgent(')
    && transcriptPaneSource.includes('<SparkleGlyph')
    && transcriptPaneSource.includes('code-agent-transcript-review-and-commit-sparkle')
    && stylesSource.includes('.code-agent-transcript-result-review.agent-review-commit')
    && stylesSource.includes('.code-agent-transcript-review-and-commit-sparkle')
    && stylesSource.includes('opacity: 0.44;'),
  'ACP change cards should mark Commit as an intelligent action with a subtle sparkle',
);

const englishCopy = codeCopyForLanguage('en');
const chineseCopy = codeCopyForLanguage('zh');
assert.strictEqual(englishCopy.agentTranscriptReviewAndCommit, 'Commit');
assert.strictEqual(chineseCopy.agentTranscriptReviewAndCommit, 'Commit');
assert.match(englishCopy.agentTranscriptReviewAndCommitPrompt, /Review/);
assert.match(englishCopy.agentTranscriptReviewAndCommitPrompt, /Commit/);
assert.match(chineseCopy.agentTranscriptReviewAndCommitPrompt, /审查/);
assert.match(chineseCopy.agentTranscriptReviewAndCommitPrompt, /提交/);

console.log('test-agent-review-commit-action passed');
