const assert = require('assert');
const { acpActivityKind, acpCompactPlanLabel, acpLiveToolActivityLabel, acpPlanProgress } = require('../../src/components/code/acp/acp-activity-label.ts');
const { codeCopyForLanguage } = require('../../src/components/code/copy.ts');

assert.strictEqual(acpActivityKind([]), 'processing');
assert.strictEqual(acpActivityKind([{ type: 'thought', status: 'completed' }]), 'thinking');
assert.strictEqual(acpActivityKind([{ type: 'tool', kind: 'execute', status: 'in_progress' }]), 'running');
assert.strictEqual(acpActivityKind([{ type: 'tool', kind: 'read', status: 'pending' }]), 'reading');
assert.strictEqual(acpActivityKind([{ type: 'tool', kind: 'search', status: 'running' }]), 'searching');
assert.strictEqual(acpActivityKind([{ type: 'patch', kind: 'edit', status: 'active' }]), 'editing');
assert.strictEqual(acpActivityKind([{ type: 'plan', status: 'running' }]), 'plan');
assert.strictEqual(
  acpActivityKind([
    { type: 'plan', status: 'running' },
    { type: 'tool', kind: 'read', status: 'completed' },
  ]),
  'processing',
);
assert.strictEqual(
  acpActivityKind([
    { type: 'plan', status: 'running' },
    { type: 'tool', kind: 'read', status: 'pending' },
  ]),
  'reading',
);
assert.deepStrictEqual(
  acpPlanProgress([{ type: 'plan', status: 'running', completedSteps: 2, totalSteps: 5 }]),
  { completed: 2, total: 5 },
);
assert.deepStrictEqual(
  acpPlanProgress([
    { type: 'plan', status: 'running', completedSteps: 2, totalSteps: 5 },
    { type: 'tool', kind: 'read', status: 'pending' },
  ]),
  { completed: 2, total: 5 },
);
assert.strictEqual(
  acpPlanProgress([{ type: 'plan', status: 'completed', completedSteps: 5, totalSteps: 5 }]),
  null,
);
assert.strictEqual(
  acpCompactPlanLabel([{ type: 'plan', status: 'running', completedSteps: 2, totalSteps: 5, currentStep: 'Update parser implementation' }]),
  '2/5 Updat…',
);
assert([...acpCompactPlanLabel([
  { type: 'plan', status: 'running', completedSteps: 2, totalSteps: 5, currentStep: '修改消息解析器' },
])].length <= 10);
assert.strictEqual(acpActivityKind([{ type: 'tool', kind: 'fetch', status: 'started' }]), 'fetching');
assert.strictEqual(acpActivityKind([{ type: 'tool', kind: 'other', status: 'pending' }]), 'tool');
assert.strictEqual(
  acpActivityKind([
    { type: 'tool', kind: 'execute', status: 'pending' },
    { type: 'thought', status: 'completed' },
  ]),
  'thinking',
);
assert.strictEqual(
  acpActivityKind([{ type: 'tool', kind: 'execute', status: 'completed' }]),
  'processing',
);
assert.strictEqual(
  acpActivityKind([
    { type: 'thought', status: 'completed' },
    { type: 'tool', kind: 'execute', status: 'completed' },
  ]),
  'processing',
);

for (const language of ['en', 'zh']) {
  const copy = codeCopyForLanguage(language);
  const labels = [
    copy.agentTranscriptWorking,
    copy.agentTranscriptThinking,
    copy.agentTranscriptRunning,
    copy.agentTranscriptReading,
    copy.agentTranscriptSearching,
    copy.agentTranscriptEditing,
    copy.agentTranscriptPlanActive,
    copy.agentTranscriptPlanProgress(2, 5),
    copy.agentTranscriptFetching,
    copy.agentTranscriptUsingTool,
  ];
  assert(labels.every(label => [...label].length <= 10), `${language} activity labels must be at most 10 characters`);

  const activityLabels = {
    thinking: copy.agentTranscriptThinking,
    running: copy.agentTranscriptRunning,
    reading: copy.agentTranscriptReading,
    searching: copy.agentTranscriptSearching,
    editing: copy.agentTranscriptEditing,
    plan: copy.agentTranscriptPlanActive,
    fetching: copy.agentTranscriptFetching,
    tool: copy.agentTranscriptUsingTool,
    processing: copy.agentTranscriptWorking,
  };
  assert.strictEqual(
    acpLiveToolActivityLabel([
      { type: 'tool', kind: 'execute', status: 'completed', title: 'old command' },
      { type: 'tool', kind: 'execute', status: 'in_progress', title: 'PORT=4187   npm test\n-- --runInBand' },
    ], activityLabels),
    `${copy.agentTranscriptRunning}: PORT=4187 npm test -- --runInBand`,
  );
  assert.strictEqual(
    acpLiveToolActivityLabel([{ type: 'tool', kind: 'execute', status: 'completed', title: 'npm test' }], activityLabels),
    '',
  );
}

console.log('test-acp-activity-label passed');
