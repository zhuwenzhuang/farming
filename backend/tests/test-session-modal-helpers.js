const assert = require('assert');

const {
  shouldUseLiveSessionText,
  deriveSessionTextPatch,
  normalizeSessionViewPayload,
  deriveSessionStreamPatch,
  getAgentDisplayText,
  extractSessionLinks,
  formatSelectionStatus,
  deriveSessionSearchMatchesFromLines,
  createSessionModalState,
  shouldPollSessionView
} = require('../../frontend/app.js');

function run() {
  assert.strictEqual(shouldUseLiveSessionText({ sessionSource: 'live-text' }), true);
  assert.strictEqual(shouldUseLiveSessionText({ sessionSource: 'buffer' }), false);
  assert.strictEqual(shouldUseLiveSessionText(null), false);
  assert.strictEqual(shouldPollSessionView('live-text'), true);
  assert.strictEqual(shouldPollSessionView('buffer'), false);

  assert.deepStrictEqual(
    deriveSessionTextPatch('hello', 0, true),
    {
      mode: 'replace',
      text: 'hello',
      nextLength: 5
    }
  );

  assert.deepStrictEqual(
    deriveSessionTextPatch('hello world', 5, false),
    {
      mode: 'append',
      text: ' world',
      nextLength: 11
    }
  );

  assert.deepStrictEqual(
    deriveSessionTextPatch('short', 12, false),
    {
      mode: 'replace',
      text: 'short',
      nextLength: 5
    }
  );

  assert.deepStrictEqual(
    deriveSessionTextPatch('steady', 6, false),
    {
      mode: 'noop',
      text: '',
      nextLength: 6
    }
  );

  assert.deepStrictEqual(
    deriveSessionTextPatch(undefined, 3, false),
    {
      mode: 'noop',
      text: '',
      nextLength: 3
    }
  );

  assert.strictEqual(
    getAgentDisplayText({
      previewText: '\u001b[32mpreview\u001b[0m',
      output: 'output'
    }),
    'preview'
  );

  assert.strictEqual(
    getAgentDisplayText({
      previewText: '',
      output: '\u001b[31moutput\u001b[0m'
    }),
    'output'
  );

  assert.deepStrictEqual(
    extractSessionLinks('See https://example.com/a?b=1 and (https://example.com/a?b=1). Then https://openai.com/docs.'),
    ['https://example.com/a?b=1', 'https://openai.com/docs']
  );

  assert.deepStrictEqual(
    extractSessionLinks('Wrapped https://example.com/path(with-parentheses) and https://example.com/query?list=[a,b].'),
    ['https://example.com/path(with-parentheses)', 'https://example.com/query?list=[a,b]']
  );

  assert.deepStrictEqual(
    extractSessionLinks('中文句号 https://logview.example.com/job/12345。'),
    ['https://logview.example.com/job/12345']
  );

  assert.strictEqual(
    formatSelectionStatus(
      {
        start: { x: 2, y: 4 },
        end: { x: 6, y: 4 }
      },
      'test'
    ),
    'Sel 5:3 -> 5:7 • 4 chars'
  );

  assert.strictEqual(formatSelectionStatus(undefined, ''), 'No selection');

  assert.deepStrictEqual(
    deriveSessionSearchMatchesFromLines(
      ['alpha beta', 'Beta alpha', 'gamma'],
      'beta'
    ),
    [
      { line: 0, startColumn: 6, length: 4, preview: 'alpha beta' },
      { line: 1, startColumn: 0, length: 4, preview: 'Beta alpha' }
    ]
  );

  assert.deepStrictEqual(
    normalizeSessionViewPayload(
      {
        session: {
          agentId: 'agent-1',
          command: 'claude',
          output: 'remote output',
          previewText: 'remote preview',
          sessionSource: 'live-text',
          status: 'running'
        }
      },
      {
        id: 'fallback-id',
        command: 'fallback',
        cwd: '/tmp',
        output: 'fallback output',
        previewText: 'fallback preview',
        sessionSource: 'buffer',
        status: 'stopped'
      }
    ),
    {
      agentId: 'agent-1',
      command: 'claude',
      cwd: '/tmp',
      status: 'running',
      sessionSource: 'live-text',
      output: 'remote output',
      previewText: 'remote preview',
      isMain: false,
      activityLevel: 'cold',
      lastActivity: null,
      startedAt: null,
      exitedAt: null
    }
  );

  assert.deepStrictEqual(
    deriveSessionStreamPatch(
      {
        agentId: 'agent-1',
        data: 'stream chunk'
      },
      'agent-1',
      'live-text'
    ),
    {
      text: 'stream chunk',
      nextLengthDelta: 12
    }
  );

  assert.strictEqual(
    deriveSessionStreamPatch(
      {
        agentId: 'agent-2',
        data: 'stream chunk'
      },
      'agent-1',
      'live-text'
    ),
    null
  );

  assert.deepStrictEqual(
    deriveSessionStreamPatch(
      {
        agentId: 'agent-1',
        data: 'local stream'
      },
      'agent-1',
      'buffer'
    ),
    {
      text: 'local stream',
      nextLengthDelta: 12
    }
  );

  const modalState = createSessionModalState(
    {
      id: 'agent-1',
      command: 'claude',
      sessionSource: 'live-text'
    },
    'terminal',
    { crtEffects: false }
  );
  assert.strictEqual(modalState.agentId, 'agent-1');
  assert.strictEqual(modalState.sessionSource, 'live-text');
  assert.strictEqual(modalState.title, 'claude (agent-1)');

  console.log('✓ Session modal helpers handle live-text routing and text patching');
}

run();
