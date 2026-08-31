const assert = require('assert');
const {
  activeCodexTerminalProfile,
  applyCodexTerminalProfile,
  codexServiceTierConfirmations,
  codexTerminalProfileFromOutput,
  codexTerminalProfileFromPreview,
  codexTerminalProfileEqual,
  codexTerminalSessionIdFromStatus,
  isCodexTerminalComposerPreview,
  modelSelectionInput,
  reasoningSelectionInput,
  resolveCodexTerminalSessionId,
  newCodexServiceTierConfirmation,
} = require('../codex-terminal-profile.cjs');
const {
  providerTerminalIdentityControl,
  providerTerminalProfileControl,
} = require('../provider-terminal-controls.cjs');

const IDLE_55 = [
  '› Improve documentation in @filename',
  '',
  '  gpt-5.5 xhigh · /workspace',
].join('\n');

const MODEL_MENU = [
  'Select Model and Effort',
  'Choose the model and reasoning effort to use',
  '',
  '  1. gpt-5.5            Stable coding model',
  '  7. gpt-5.6-luna       Fastest variant',
  '› 8. gpt-5.6-sol        Strong coding variant',
].join('\n');

// Codex 0.151 presents quick modes before its full model/effort picker.
const QUICK_MODEL_MENU = [
  'Select Model',
  'Pick a quick mode or browse all models.',
  '  1. codex-auto-review   AI model available through this gateway.',
  '› 2. All models (current)  Choose a specific model and reasoning level (current: gpt-5.6-luna)',
  '',
  'gpt-5.6-luna low · /workspace',
].join('\n');

const REASONING_MENU = [
  'Select Reasoning Level for gpt-5.6-sol',
  '',
  '  1. Low                Fast responses',
  '  2. Medium             Balanced',
  '  3. High               Deeper reasoning',
  '› 4. Extra high         Deep reasoning',
  '  5. More reasoning…    Max and Ultra consume usage limits faster',
].join('\n');

const ADVANCED_REASONING_MENU = [
  'Advanced Reasoning',
  '⚠ Consumes usage limits faster',
  '› 1. Max                For difficult problems',
  '  2. Ultra              For demanding multi-agent work',
].join('\n');

async function run() {
  const statusSessionId = '019fc332-185d-73f2-b1be-0054f2778cab';
  const statusPreview = [
    'OpenAI Codex (v0.146.0)',
    '',
    '  Model:                gpt-5.6-sol (reasoning high)',
    '  Directory:            ~/git/farming',
    '  Permissions:          Workspace (Ask for approval)',
    '  Agents.md:            AGENTS.md',
    '  Account:              user@example.com (Pro)',
    '  Collaboration mode:   Default',
    `  Session:              ${statusSessionId}`,
    '',
    '› Write tests for @filename',
    '',
    '  gpt-5.6-sol high · ~/git/farming',
  ].join('\n');
  assert.strictEqual(codexTerminalSessionIdFromStatus(statusPreview), statusSessionId);
  const identityControl = providerTerminalIdentityControl('codex');
  assert(identityControl, 'Codex must publish its delayed Terminal identity control');
  assert.strictEqual(identityControl.provider, 'codex');
  assert.strictEqual(identityControl.source, 'codex-terminal-status');
  assert.strictEqual(identityControl.sessionIdFromPreview(statusPreview), statusSessionId);
  assert.strictEqual(identityControl.canResolveFromPreview(IDLE_55), true);
  assert.strictEqual(
    providerTerminalIdentityControl('claude'),
    null,
    'providers with launch-time session ids must not inherit the Codex /status probe',
  );
  assert(providerTerminalProfileControl('codex'), 'Codex must publish its native Terminal profile control');
  assert.strictEqual(
    providerTerminalProfileControl('claude'),
    null,
    'providers without a native Terminal profile transaction must not inherit Codex menus',
  );
  const borderedStatusPreview = [
    '╭────────────────────────────────────────────────────────────────────────╮',
    '│  >_ OpenAI Codex (v0.146.0)                                            │',
    '│                                                                        │',
    '│  Model:                gpt-5.6-luna (reasoning medium, summaries auto) │',
    '│  Model provider:       example - https://example.invalid/v1            │',
    '│  Directory:            ~/git/farming                                   │',
    '│  Permissions:          Full Access                                     │',
    '│  Agents.md:            AGENTS.md                                       │',
    '│  Collaboration mode:   Default                                         │',
    `│  Session:              ${statusSessionId}            │`,
    '╰────────────────────────────────────────────────────────────────────────╯',
  ].join('\n');
  assert.strictEqual(
    codexTerminalSessionIdFromStatus(borderedStatusPreview),
    statusSessionId,
    'current Codex status panels should materialize a resumable Terminal session id',
  );
  assert.strictEqual(
    codexTerminalSessionIdFromStatus(`user pasted Session: ${statusSessionId}`),
    '',
    'a UUID outside the structured /status block must not be accepted',
  );
  assert.strictEqual(isCodexTerminalComposerPreview(IDLE_55), true);
  assert.strictEqual(isCodexTerminalComposerPreview(MODEL_MENU), false);
  assert.strictEqual(isCodexTerminalComposerPreview(QUICK_MODEL_MENU), false,
    'the quick-mode picker must not be mistaken for its unchanged composer footer');
  assert.strictEqual(isCodexTerminalComposerPreview(QUICK_MODEL_MENU.replace(/\n/g, '\r\n')), false,
    'CRLF terminal previews must recognize the same quick-mode picker');

  let identityPreview = IDLE_55;
  const identityInputs = [];
  const resolvedIdentity = await resolveCodexTerminalSessionId({
    readPreview: async () => identityPreview,
    sendInput: async input => {
      identityInputs.push(input);
      identityPreview = statusPreview;
    },
    sleep: async () => {},
    pollIntervalMs: 0,
    timeoutMs: 1000,
  });
  assert.strictEqual(resolvedIdentity, statusSessionId);
  assert.deepStrictEqual(identityInputs, [
    [{ type: 'paste', text: '/status' }, '\r'],
  ], 'identity resolution should issue exactly one local /status command');

  let uncertainIdentityPreview = IDLE_55;
  const uncertainIdentityInputs = [];
  assert.strictEqual(await resolveCodexTerminalSessionId({
    readPreview: async () => uncertainIdentityPreview,
    sendInput: async input => {
      uncertainIdentityInputs.push(input);
      uncertainIdentityPreview = statusPreview;
      throw new Error('transport reply lost after PTY write');
    },
    sleep: async () => {},
    pollIntervalMs: 0,
    timeoutMs: 1000,
  }), statusSessionId, 'an uncertain PTY write should reconcile from the rendered status response');
  assert.strictEqual(uncertainIdentityInputs.length, 1, 'an uncertain /status write must not be replayed');

  await assert.rejects(resolveCodexTerminalSessionId({
    readPreview: async () => MODEL_MENU,
    sendInput: async () => assert.fail('selection pages must not receive /status'),
    timeoutMs: 1000,
  }), /not at its idle composer/);

  assert.deepStrictEqual(
    codexTerminalProfileFromPreview('gpt-5.6-sol xhigh fast · ~/git/farming'),
    { model: 'gpt-5.6-sol', effort: 'xhigh', fast: true }
  );
  assert.deepStrictEqual(
    codexTerminalProfileFromOutput([
      '• Model changed to gpt-5.6-sol xhigh',
      '• Service tier set to priority',
      'gpt-5.5 xhigh · stale simplified preview',
    ].join('\n')),
    { model: 'gpt-5.6-sol', effort: 'xhigh', fast: true },
    'explicit PTY confirmations should outrank a stale simplified footer'
  );
  assert.deepStrictEqual(
    codexTerminalProfileFromPreview('• Service tier set to priority\n\ngpt-5.6-sol xhigh · ~/git/farming'),
    { model: 'gpt-5.6-sol', effort: 'xhigh', fast: true },
    'newer Codex versions confirm Fast separately instead of adding it to the footer'
  );
  assert.deepStrictEqual(
    codexTerminalProfileFromPreview('gpt-5.6-sol xhigh · ~/git/farming'),
    { model: 'gpt-5.6-sol', effort: 'xhigh', fast: false },
    'a footer without a Fast marker reports the default service tier'
  );
  const projectedAgent = {
    id: 'codex-terminal',
    command: 'codex',
    output: '• Model changed to gpt-5.6-sol xhigh\n• Service tier set to priority',
    status: 'running',
  } as unknown as import('../agent-manager-record-types').AgentRecord;
  const projectedProfile = activeCodexTerminalProfile(projectedAgent, IDLE_55);
  assert.deepStrictEqual(projectedProfile, {
    model: 'gpt-5.6-sol',
    reasoningEffort: 'xhigh',
    serviceTier: 'priority',
    source: 'terminal-output',
  });
  assert.strictEqual(projectedAgent.codexTerminalProfile, projectedProfile);
  assert.strictEqual(codexTerminalProfileEqual(projectedProfile, { ...projectedProfile }), true);
  assert.strictEqual(codexTerminalProfileEqual(projectedProfile, {
    ...projectedProfile,
    serviceTier: 'default',
  }), false);
  assert.strictEqual(activeCodexTerminalProfile({
    command: 'claude',
    status: 'running',
  } as unknown as import('../agent-manager-record-types').AgentRecord, IDLE_55), null);
  assert.deepStrictEqual(codexServiceTierConfirmations(
    '• Service tier set to priority\n• Service tier set to default'
  ), [
    { serviceTier: 'priority', fast: true },
    { serviceTier: 'default', fast: false },
  ]);
  assert.deepStrictEqual(codexServiceTierConfirmations(
    '• Fast mode is on.\n• Fast mode is off.'
  ), [
    { serviceTier: 'priority', fast: true },
    { serviceTier: 'default', fast: false },
  ], 'current Codex Fast confirmations should release the Terminal input queue');
  assert.deepStrictEqual(codexServiceTierConfirmations(
    '• 已开启 Fast 模式。\n• 已关闭 Fast 模式。'
  ), [
    { serviceTier: 'priority', fast: true },
    { serviceTier: 'default', fast: false },
  ], 'localized Codex Fast confirmations should release the Terminal input queue');
  assert.deepStrictEqual(
    newCodexServiceTierConfirmation(
      '• Service tier set to default',
      '• Service tier set to default\n• Service tier set to priority'
    ),
    { serviceTier: 'priority', fast: true }
  );
  assert.strictEqual(modelSelectionInput(MODEL_MENU, 'gpt-5.6-sol'), '8');
  assert.strictEqual(reasoningSelectionInput(REASONING_MENU, 'xhigh'), '4');
  assert.strictEqual(reasoningSelectionInput(
    'Select Reasoning Level for gpt-5.6-sol\n  1. Low\n  5. Max',
    'max'
  ), '5', 'older Codex versions with a direct Max option should remain supported');
  assert.strictEqual(reasoningSelectionInput(ADVANCED_REASONING_MENU, 'max'), '1');
  assert.strictEqual(reasoningSelectionInput(ADVANCED_REASONING_MENU, 'ultra'), '2');

  let preview = IDLE_55;
  let stage = 'idle';
  let readsInStage = 0;
  const inputs = [];
  const readPreview = async () => {
    readsInStage += 1;
    if (stage === 'opening-model' && readsInStage >= 4) {
      preview = MODEL_MENU;
      stage = 'model-menu';
    } else if (stage === 'opening-reasoning' && readsInStage >= 3) {
      preview = REASONING_MENU;
      stage = 'reasoning-menu';
    } else if (stage === 'opening-advanced-reasoning' && readsInStage >= 4) {
      preview = ADVANCED_REASONING_MENU;
      stage = 'advanced-reasoning-menu';
    } else if (stage === 'applying-model' && readsInStage >= 5) {
      preview = 'Model changed to gpt-5.6-sol ultra\n\ngpt-5.6-sol ultra · /workspace';
      stage = 'model-applied';
    } else if (stage === 'applying-fast' && readsInStage >= 3) {
      preview = 'gpt-5.6-sol ultra fast · /workspace';
      stage = 'fast-applied';
    }
    return preview;
  };
  const sendInput = async input => {
    inputs.push(input);
    readsInStage = 0;
    if (Array.isArray(input) && input[0]?.text === '/model') stage = 'opening-model';
    else if (input === '8') stage = 'opening-reasoning';
    else if (input === '5') stage = 'opening-advanced-reasoning';
    else if (input === '2') stage = 'applying-model';
    else if (Array.isArray(input) && input[0]?.text === '/fast') stage = 'applying-fast';
  };

  const applied = await applyCodexTerminalProfile({
    profile: { model: 'gpt-5.6-sol', effort: 'ultra', serviceTier: 'priority' },
    readPreview,
    sendInput,
    sleep: async () => {},
    pollIntervalMs: 0,
    timeoutMs: 1000,
  });

  assert.deepStrictEqual(inputs, [
    [{ type: 'paste', text: '/model' }, '\r'],
    '8',
    '5',
    '2',
    [{ type: 'paste', text: '/fast' }, '\r'],
  ], 'profile changes should wait for each rendered Codex picker instead of relying on fixed delays');
  assert.deepStrictEqual(applied, {
    model: 'gpt-5.6-sol',
    effort: 'ultra',
    serviceTier: 'priority',
  });

  for (const effort of ['low', 'ultra']) {
    let quickPreview = IDLE_55;
    const quickInputs = [];
    let pendingAppliedReads = 0;
    const targetFooter = `gpt-5.6-sol ${effort} · /workspace`;
    const result = await applyCodexTerminalProfile({
      profile: { model: 'gpt-5.6-sol', effort, serviceTier: 'default' },
      readPreview: async () => {
        if (pendingAppliedReads > 0 && --pendingAppliedReads === 0) quickPreview = targetFooter;
        return quickPreview;
      },
      sendInput: async input => {
        quickInputs.push(input);
        if (Array.isArray(input)) quickPreview = QUICK_MODEL_MENU;
        else if (quickPreview === QUICK_MODEL_MENU && input === '2') quickPreview = MODEL_MENU;
        else if (quickPreview === MODEL_MENU && input === '8') quickPreview = `${REASONING_MENU}\n${targetFooter}`;
        else if (input === '5') quickPreview = `${ADVANCED_REASONING_MENU}\n${targetFooter}`;
        else if (input === (effort === 'low' ? '1' : '2')) pendingAppliedReads = 3;
        else assert.fail(`unexpected quick-picker input: ${JSON.stringify(input)}`);
      },
      sleep: async () => {},
      pollIntervalMs: 0,
      timeoutMs: 1000,
    });
    assert.deepStrictEqual(quickInputs, [
      [{ type: 'paste', text: '/model' }, '\r'], '2', '8',
      ...(effort === 'low' ? ['1'] : ['5', '2']),
    ], 'quick modes must enter All models once, then use the existing model/effort transaction');
    assert.deepStrictEqual(result, { model: 'gpt-5.6-sol', effort, serviceTier: 'default' });
    assert.strictEqual(pendingAppliedReads, 0,
      'matching profile text under an active picker must not confirm completion');
  }

  await assert.rejects(applyCodexTerminalProfile({
    profile: { model: 'gpt-5.6-luna', effort: 'low', serviceTier: 'default' },
    readPreview: async () => QUICK_MODEL_MENU,
    sendInput: async () => assert.fail('an existing quick picker must reject a new transaction'),
  }), /Close the active Codex Terminal menu/);

  const pagedCatalog = [
    'model-1', 'model-2', 'model-3', 'model-4', 'model-5', 'model-6', 'model-7',
    'gpt-5.6-terra', 'gpt-5.6-sol-openai-compact', 'gpt-5.6-sol', 'gpt-5.6-luna', 'model-12',
  ];
  for (const scenario of ['hidden-target', 'visible-two-digit', 'three-digit', 'wrap-target', 'missing-target', 'missing-cursor', 'stalled-cursor', 'move-uncertain', 'move-canceled']) {
    const pagedModels = scenario === 'three-digit'
      ? Array.from({ length: 102 }, (_, index) => index === 99 ? 'gpt-5.6-sol' : `model-${index + 1}`)
      : pagedCatalog;
    const target = scenario === 'wrap-target' ? 'model-2'
      : scenario === 'missing-target' ? 'model-absent' : 'gpt-5.6-sol';
    let selected = scenario === 'three-digit' ? 99 : scenario === 'wrap-target' ? 10 : 8;
    let firstVisible = scenario === 'three-digit' ? 92
      : scenario === 'visible-two-digit' ? 3 : scenario === 'wrap-target' ? 5 : 1;
    const renderPage = () => [
      'Select Model and Effort',
      ...pagedModels.slice(firstVisible - 1, firstVisible + 7).map((model, offset) => {
        const index = firstVisible + offset;
        const marker = scenario !== 'missing-cursor' && index === selected ? '›' : ' ';
        return `${marker} ${index}. ${model}  Available model`;
      }),
      'gpt-5.5 xhigh · /workspace',
    ].join('\r\n');
    let pagedPreview = IDLE_55;
    let pendingPreview = '';
    let staleReads = 0;
    const pagedInputs = [];
    const controller = new globalThis.AbortController();
    const originalNow = Date.now;
    let controlledNow = originalNow();
    if (scenario === 'stalled-cursor') Date.now = () => controlledNow;
    try {
      const applying = applyCodexTerminalProfile({
        profile: { model: target, effort: 'low', serviceTier: 'default' },
        readPreview: async () => {
          if (staleReads > 0 && --staleReads === 0) pagedPreview = pendingPreview;
          return pagedPreview;
        },
        sendInput: async input => {
          pagedInputs.push(input);
          if (Array.isArray(input)) pagedPreview = renderPage();
          else if (input === '\x1b[B') {
            assert.strictEqual(staleReads, 0, 'do not repeat navigation before the prior cursor move is visible');
            if (scenario === 'stalled-cursor') return;
            selected = selected % pagedModels.length + 1;
            if (selected < firstVisible) firstVisible = selected;
            if (selected > firstVisible + 7) firstVisible = selected - 7;
            pendingPreview = renderPage();
            staleReads = 3;
            if (scenario === 'move-uncertain') throw new Error('navigation write outcome unknown');
            if (scenario === 'move-canceled') controller.abort(new Error('navigation canceled'));
          } else if (input === '\r') {
            assert.strictEqual(pagedModels[selected - 1], target, 'Enter must select the exact highlighted model');
            pagedPreview = `Select Reasoning Level for ${target}\n  1. Low  Fast responses`;
          } else if (input === '1') pagedPreview = `${target} low · /workspace`;
          else if (input === '\x1b') { staleReads = 0; pagedPreview = IDLE_55; }
          else assert.fail(`unsafe paged model selection: ${JSON.stringify(input)}`);
        },
        signal: controller.signal,
        sleep: async () => {
          // Expire the 72ms operation budget, keeping its 8ms cleanup reserve.
          // This exercises the original deadline without host scheduling races.
          if (scenario === 'stalled-cursor') controlledNow += 72;
        },
        pollIntervalMs: 0,
        timeoutMs: scenario === 'stalled-cursor' ? 80 : 1000,
      });
      if (scenario === 'missing-target' || scenario === 'missing-cursor' || scenario === 'stalled-cursor' || scenario.startsWith('move-')) {
        const expected = scenario === 'missing-target' ? /Model model-absent is not available/
          : scenario === 'missing-cursor' ? /did not identify its selected model/
            : scenario === 'stalled-cursor' ? /did not advance while locating/
              : scenario === 'move-uncertain' ? /navigation write outcome unknown/ : /navigation canceled/;
        await assert.rejects(applying, expected);
        assert.strictEqual(pagedInputs.filter(input => input === '\x1b[B').length,
          scenario === 'missing-target' ? pagedModels.length : scenario === 'missing-cursor' ? 0 : 1);
        assert.strictEqual(pagedInputs.at(-1), '\x1b', 'failed navigation closes the single model picker');
        assert.strictEqual(pagedPreview, IDLE_55);
        assert(!pagedInputs.includes('\r'), 'a missing or uncertain target must never be selected');
      } else {
        assert.deepStrictEqual(await applying, { model: target, effort: 'low', serviceTier: 'default' });
        const expectedMoves = scenario === 'three-digit' ? 1 : scenario === 'wrap-target' ? 4 : 2;
        assert.deepStrictEqual(pagedInputs, [[{ type: 'paste', text: '/model' }, '\r'], ...Array(expectedMoves).fill('\x1b[B'), '\r', '1']);
      }
    } finally {
      if (scenario === 'stalled-cursor') Date.now = originalNow;
    }
  }

  for (const failure of ['missing-all-models', 'all-models-write-lost', 'missing-model', 'model-write-lost', 'advanced-canceled']) {
    let failurePreview = IDLE_55;
    const failureInputs = [];
    const controller = new globalThis.AbortController();
    const reason = failure === 'advanced-canceled' ? 'quick picker canceled' : failure;
    await assert.rejects(applyCodexTerminalProfile({
      profile: { model: 'gpt-5.6-sol', effort: 'ultra', serviceTier: 'default' },
      readPreview: async () => failurePreview,
      sendInput: async input => {
        failureInputs.push(input);
        if (Array.isArray(input)) {
          failurePreview = failure === 'missing-all-models'
            ? QUICK_MODEL_MENU.replace('All models (current)', 'Other quick mode') : QUICK_MODEL_MENU;
        } else if (input === '2') {
          failurePreview = failure === 'missing-model' ? MODEL_MENU.replace('gpt-5.6-sol', 'gpt-5.6-sol-openai-compact') : MODEL_MENU;
          if (failure === 'all-models-write-lost') throw new Error(reason);
        } else if (input === '8') {
          failurePreview = REASONING_MENU;
          if (failure === 'model-write-lost') throw new Error(reason);
        }
        else if (input === '5') { failurePreview = ADVANCED_REASONING_MENU; controller.abort(new Error(reason)); }
        else if (input === '\x1b[B' && failure === 'missing-model') {
          const index = Number(failurePreview.match(/^› (\d+)\./m)?.[1]);
          const next = index === 8 ? 1 : index === 1 ? 7 : 8;
          failurePreview = MODEL_MENU.replace('gpt-5.6-sol', 'gpt-5.6-sol-openai-compact')
            .replace('› 8.', '  8.').replace(new RegExp(`^  ${next}\\.`, 'm'), `› ${next}.`);
        }
        else if (input === '\x1b') {
          if (failurePreview === ADVANCED_REASONING_MENU) failurePreview = REASONING_MENU;
          else if (failurePreview === REASONING_MENU) failurePreview = MODEL_MENU;
          else failurePreview = IDLE_55;
        }
      },
      sleep: async () => {},
      pollIntervalMs: 0,
      timeoutMs: 1000,
      signal: controller.signal,
    }), failure === 'missing-all-models' ? /did not offer All models/
      : failure === 'missing-model' ? /Model gpt-5.6-sol is not available/ : new RegExp(reason));
    const expectedDepth = failure === 'advanced-canceled' ? 3 : failure === 'model-write-lost' ? 2 : 1;
    assert.strictEqual(failureInputs.filter(input => input === '\x1b').length, expectedDepth,
      `${failure} must close every anticipated picker level within the same deadline`);
    assert.strictEqual(failureInputs.filter(input => input === '2').length, failure === 'missing-all-models' ? 0 : 1,
      'an uncertain All models write must never be replayed');
    assert.strictEqual(failurePreview, IDLE_55,
      `${failure} must return through the observed parent menus to the composer`);
  }

  let modernOutput = 'booted';
  const modernInputs = [];
  const modernApplied = await applyCodexTerminalProfile({
    profile: { model: 'gpt-5.6-sol', effort: 'xhigh', serviceTier: 'default' },
    readPreview: async () => 'gpt-5.6-sol xhigh fast · /workspace',
    readOutput: async () => modernOutput,
    sendInput: async input => {
      modernInputs.push(input);
      modernOutput += '\n• Fast mode is off.';
    },
    sleep: async () => {},
    pollIntervalMs: 0,
    timeoutMs: 1000,
  });
  assert.deepStrictEqual(modernInputs, [
    [{ type: 'paste', text: '/fast' }, '\r'],
  ], 'a known Fast profile should receive one toggle when the target is default');
  assert.deepStrictEqual(modernApplied, {
    model: 'gpt-5.6-sol',
    effort: 'xhigh',
    serviceTier: 'default',
  });

  const defaultInputs = [];
  const defaultApplied = await applyCodexTerminalProfile({
    profile: { model: 'gpt-5.6-sol', effort: 'xhigh', serviceTier: 'default' },
    readPreview: async () => 'gpt-5.6-sol xhigh · /workspace',
    sendInput: async input => defaultInputs.push(input),
    sleep: async () => {},
    pollIntervalMs: 0,
    timeoutMs: 1000,
  });
  assert.deepStrictEqual(defaultInputs, [], 'the default tier must not send a Fast toggle');
  assert.deepStrictEqual(defaultApplied, {
    model: 'gpt-5.6-sol',
    effort: 'xhigh',
    serviceTier: 'default',
  });

  await assert.rejects(
    applyCodexTerminalProfile({
      profile: { model: 'gpt-5.6-sol', effort: 'xhigh', serviceTier: 'default' },
      readPreview: async () => 'Codex is working…',
      sendInput: async () => assert.fail('busy terminals must not receive /model'),
    }),
    /not idle/
  );

  let pickerOpened = false;
  const deadlineInputs = [];
  const deadlineStartedAt = Date.now();
  await assert.rejects(
    applyCodexTerminalProfile({
      profile: { model: 'gpt-5.6-sol', effort: 'xhigh', serviceTier: 'default' },
      readPreview: async () => {
        if (!pickerOpened) return IDLE_55;
        return new Promise(() => {});
      },
      sendInput: async input => {
        deadlineInputs.push(input);
        if (Array.isArray(input) && input[0]?.text === '/model') pickerOpened = true;
      },
      timeoutMs: 80,
      pollIntervalMs: 1,
    }),
    /Codex did not open its model menu/,
  );
  assert(Date.now() - deadlineStartedAt < 500, 'all picker stages must share one hard deadline');
  assert.deepStrictEqual(deadlineInputs, [
    [{ type: 'paste', text: '/model' }, '\r'],
    '\x1b',
  ], 'a timed-out picker gets one bounded Escape cleanup before returning');

  const uncertainOpenInputs = [];
  await assert.rejects(
    applyCodexTerminalProfile({
      profile: { model: 'gpt-5.6-sol', effort: 'xhigh', serviceTier: 'default' },
      readPreview: async () => IDLE_55,
      sendInput: async input => {
        uncertainOpenInputs.push(input);
        if (Array.isArray(input) && input[0]?.text === '/model') {
          throw new Error('transport reply lost after PTY write');
        }
      },
      timeoutMs: 1000,
    }),
    /transport reply lost after PTY write/,
  );
  assert.deepStrictEqual(uncertainOpenInputs, [
    [{ type: 'paste', text: '/model' }, '\r'],
    '\x1b',
  ], 'an uncertain /model write must still close the possibly opened picker');

  let uncertainAdvancedPreview = IDLE_55;
  const uncertainAdvancedInputs = [];
  await assert.rejects(
    applyCodexTerminalProfile({
      profile: { model: 'gpt-5.6-sol', effort: 'ultra', serviceTier: 'default' },
      readPreview: async () => uncertainAdvancedPreview,
      sendInput: async input => {
        uncertainAdvancedInputs.push(input);
        if (Array.isArray(input) && input[0]?.text === '/model') uncertainAdvancedPreview = MODEL_MENU;
        else if (input === '8') uncertainAdvancedPreview = REASONING_MENU;
        else if (input === '5') {
          uncertainAdvancedPreview = ADVANCED_REASONING_MENU;
          throw new Error('advanced menu reply lost after PTY write');
        } else if (input === '\x1b') {
          if (uncertainAdvancedPreview === ADVANCED_REASONING_MENU) uncertainAdvancedPreview = REASONING_MENU;
          else if (uncertainAdvancedPreview === REASONING_MENU) uncertainAdvancedPreview = MODEL_MENU;
          else uncertainAdvancedPreview = IDLE_55;
        }
      },
      sleep: async () => {},
      pollIntervalMs: 0,
      timeoutMs: 1000,
    }),
    /advanced menu reply lost after PTY write/,
  );
  assert.deepStrictEqual(uncertainAdvancedInputs.slice(-3), ['\x1b', '\x1b', '\x1b'],
    'an uncertain advanced-menu write must close advanced, reasoning, and model picker levels');
  assert.strictEqual(uncertainAdvancedPreview, IDLE_55,
    'the direct model picker must use the same observed parent menus to recover its composer');

  const abortController = new globalThis.AbortController();
  const abortedProfile = applyCodexTerminalProfile({
    profile: { model: 'gpt-5.6-sol', effort: 'xhigh', serviceTier: 'default' },
    readPreview: async () => new Promise(() => {}),
    sendInput: async () => {},
    timeoutMs: 1000,
    signal: abortController.signal,
  });
  abortController.abort(new Error('profile canceled by test'));
  await assert.rejects(abortedProfile, /profile canceled by test/);

  console.log('test-codex-terminal-profile passed');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
