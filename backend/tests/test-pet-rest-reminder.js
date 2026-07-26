const assert = require('assert');
const fs = require('fs');
const path = require('path');

(async () => {
  const petSource = fs.readFileSync(
    path.join(__dirname, '../../src/components/code/pet/FarmingPet.tsx'),
    'utf8',
  );
  const bubbleSource = fs.readFileSync(
    path.join(__dirname, '../../src/components/code/pet/PetBubble.tsx'),
    'utf8',
  );
  const glassSceneSource = fs.readFileSync(
    path.join(__dirname, '../../src/components/code/pet/GlassPetRestScene.tsx'),
    'utf8',
  );
  const blackHoleSceneSource = fs.readFileSync(
    path.join(__dirname, '../../src/components/code/pet/BlackHolePetRestScene.tsx'),
    'utf8',
  );
  const blackHoleRendererSource = fs.readFileSync(
    path.join(__dirname, '../../src/components/code/pet/black-hole-renderer.ts'),
    'utf8',
  );
  const blackHoleMapShaderSource = blackHoleRendererSource.slice(
    blackHoleRendererSource.indexOf('const MAP_SHADER'),
    blackHoleRendererSource.indexOf('const COMPOSITOR_SHADER'),
  );
  const capabilitySource = fs.readFileSync(
    path.join(__dirname, '../../src/components/code/pet/useRestReminderCapability.ts'),
    'utf8',
  );
  const sidebarSource = fs.readFileSync(
    path.join(__dirname, '../../src/components/code/CodeSidebar.tsx'),
    'utf8',
  );
  const workspaceSource = fs.readFileSync(
    path.join(__dirname, '../../src/components/CodeWorkspace.tsx'),
    'utf8',
  );
  const mainCssSource = fs.readFileSync(
    path.join(__dirname, '../../src/styles/main.css'),
    'utf8',
  );
  assert(petSource.includes('需要长时使用休息提醒吗？'));
  assert(petSource.includes('之后可随时在设置的“Farming Pet”中调整或关闭。'));
  assert(petSource.includes("tryReminder: zh ? '试用一下'"));
  assert(petSource.includes("disable: zh ? '关闭'"));
  assert(petSource.includes("kind: 'onboarding', step: 'appearance'"));
  assert(petSource.includes("softGlow: zh ? '柔光'"));
  assert(petSource.includes("blackHole: zh ? '黑洞'"));
  assert(petSource.includes('它只会在需要提醒休息时出现。'));
  assert(petSource.includes("restingBody: zh ? '让眼睛和注意力暂停片刻。'"));
  assert(petSource.includes("endBreak: zh ? '结束休息' : 'End break'"));
  assert(petSource.includes("cancelBreak: zh ? '取消本次休息'"));
  assert(petSource.includes('。<br />操作暂停'));
  assert(petSource.includes('className="code-pet-countdown">{countdownSeconds} 秒</strong>'));
  assert(bubbleSource.includes('body: ReactNode'));
  assert(!petSource.includes('start-break'));
  assert(petSource.includes("kind: 'onboarding', step: 'invitation'"));
  assert(petSource.includes("kind: 'capability'"));
  assert(petSource.includes("capability: 'rest-reminder'"));
  assert(petSource.includes(
    'useRestReminderCapability(intervalSeconds, restReminderEntryBlocked)',
  ));
  assert(petSource.includes(
    "if (restReminderEntryBlocked && restReminder?.phase !== 'resting') return null",
  ));
  assert(capabilitySource.includes('const ACTIVITY_COMMIT_INTERVAL_MS = 1000'));
  assert(capabilitySource.includes('entryBlockedRef.current = entryBlocked'));
  assert(capabilitySource.includes("if (entryBlocked && state.phase !== 'resting') return undefined"));
  assert(capabilitySource.includes(
    "commit(reduceRestReminder(current, { type: 'activity', now: Date.now() }))",
  ));
  assert(sidebarSource.includes('restReminderEntryBlocked={'));
  assert(sidebarSource.includes('|| brandDialogOpen'));
  assert(sidebarSource.includes('|| instanceNameDialogOpen'));
  assert(sidebarSource.includes('|| appModeDialogOpen'));
  assert(workspaceSource.includes('settingsPanelOpen'));
  assert(workspaceSource.includes('|| Boolean(mobileShareUrl)'));
  assert(workspaceSource.includes('|| Boolean(renameDialog)'));
  assert(workspaceSource.includes('|| Boolean(killDialog)'));
  assert(workspaceSource.includes('|| Boolean(deleteWorktreeDialog)'));
  assert(capabilitySource.includes("window.addEventListener('pointerdown', recordActivity, true)"));
  assert(capabilitySource.includes('pendingActivityAtRef'));
  assert(capabilitySource.includes('readRestReminderRuntimeState(interval)'));
  assert(capabilitySource.includes("document.addEventListener('visibilitychange', syncVisibility)"));
  assert(capabilitySource.includes('if (!pageVisible || !state) return undefined'));
  assert(petSource.includes('active={pageVisible}'));
  assert(
    petSource.includes("const PET_OWNER_ATTRIBUTE = 'data-farming-pet-owner'")
      && petSource.includes("const PET_OWNER_EVENT = 'farming:pet-owner-change'")
      && petSource.includes('return ownsPet ? <FarmingPetController {...props} /> : null'),
    'only the newest mounted Pet controller may own the page-level rest portal',
  )
  assert(bubbleSource.includes('className="code-pet-bubble"'));
  assert(bubbleSource.includes('aria-modal="false"'));
  assert(!bubbleSource.includes('autoFocus'));
  assert(!bubbleSource.includes('.focus('));
  assert(bubbleSource.includes('role="status" aria-live="polite"'));
  assert(glassSceneSource.includes('className="code-pet-glass-rest-overlay"'));
  assert(glassSceneSource.includes('data-testid="pet-rest-scene"'));
  assert(glassSceneSource.includes('className="code-pet-glass-rest-actions"'));
  assert(glassSceneSource.includes('if (!active) return undefined'));
  assert(glassSceneSource.includes('appRoot.inert = true'));
  assert(glassSceneSource.includes('endButtonRef.current?.focus'));
  assert(glassSceneSource.includes("event.key !== 'Escape'"));
  assert(glassSceneSource.includes('event.stopImmediatePropagation()'));
  assert(glassSceneSource.includes("window.addEventListener('keydown', onKeyDown, true)"));
  assert(petSource.includes("if (appearance === 'black-hole')"));
  assert(petSource.includes('<BlackHolePetRestScene'));
  assert(petSource.includes("restingStatus: zh ? '休息中'"));
  assert(blackHoleSceneSource.includes('data-pet-appearance="black-hole"'));
  assert(blackHoleSceneSource.includes('className="code-pet-black-hole-status"'));
  assert(blackHoleSceneSource.includes('<SevenSegmentTime value={remainingTime} />'));
  assert(blackHoleSceneSource.includes('rendererRef.current?.setActive(active)'));
  assert(blackHoleSceneSource.includes("event.key !== 'Escape'"));
  assert(!blackHoleSceneSource.includes('code-pet-close'));
  assert(blackHoleRendererSource.includes("canvas.getContext('webgl2'"));
  assert(
    blackHoleRendererSource.includes('preserveDrawingBuffer: preserveForVisualRegression')
      && blackHoleRendererSource.includes("window as Window & { __FARMING_E2E__?: boolean }"),
    'pixel-level browser checks may preserve the rendered frame without changing production buffering',
  )
  assert(blackHoleRendererSource.includes('requestAnimationFrame(frame)'));
  assert(blackHoleRendererSource.includes('document.hidden'));
  assert(blackHoleRendererSource.includes('const INTRO_SECONDS = 15'));
  assert(blackHoleRendererSource.includes('const MIDDLE_CYCLE_SECONDS = 90'));
  assert(blackHoleRendererSource.includes('export const BLACK_HOLE_EXIT_SECONDS = 15'));
  assert(blackHoleRendererSource.includes('crypto.getRandomValues'));
  assert(blackHoleRendererSource.includes('createCompositorRenderer'));
  assert(blackHoleRendererSource.includes('createSceneImage'));
  assert(blackHoleRendererSource.includes("await import('html2canvas')"));
  assert(blackHoleRendererSource.includes('createXtermSnapshotOverlays'));
  assert(blackHoleRendererSource.includes('foreignObjectRendering: false'));
  assert(blackHoleRendererSource.includes("element.tagName === 'BROWSER-MCP-CONTAINER'"));
  assert(blackHoleRendererSource.includes("highMap\n    .getContext('webgl2')"));
  assert(blackHoleRendererSource.includes("lowMap\n    .getContext('webgl2')"));
  assert(blackHoleRendererSource.includes('canvas.dataset.captureMs'));
  assert(blackHoleRendererSource.includes('PET_SNAPSHOT_EXCLUDE_SELECTOR'));
  assert(blackHoleRendererSource.includes('excludedElements.forEach(element => element.remove())'));
  assert(blackHoleRendererSource.includes('image.dataset.remainingPetElements'));
  assert(blackHoleRendererSource.includes('__farmingBlackHolePetTest'));
  assert(
    blackHoleRendererSource.includes('smoother(offsetPixels / ${BLUR_OFFSET_PX.toFixed(1)})'),
    'production compositor should preserve the reference pixel-space blur activity',
  )
  assert(
    blackHoleRendererSource.includes('vec2(0.72) * uPixelRatio * softness'),
    'production compositor should preserve the reference DPR-scaled blur taps',
  )
  assert(
    blackHoleMapShaderSource.includes('sourcePoint = mix(tracedSourcePoint, farSourcePoint, farMix)'),
    'near-field ray tracing and the far-field approximation should blend smoothly',
  )
  assert(
    !blackHoleMapShaderSource.includes('if (impact >= maxImpact)'),
    'the lens map must not expose a hard radial implementation seam',
  )
  assert(
    blackHoleRendererSource.includes('float blendInnerImpact = maxImpact - 1.5;')
      && blackHoleRendererSource.includes('float blendOuterImpact = maxImpact + 1.5;')
      && blackHoleRendererSource.includes('mix(tracedSourcePoint, farSourcePoint, farMix)'),
    'near-field tracing and the far-field approximation should meet through a smooth band',
  )
  const displacementMapShaderSource = blackHoleRendererSource.slice(
    blackHoleRendererSource.indexOf('const MAP_SHADER'),
    blackHoleRendererSource.indexOf('const COMPOSITOR_SHADER'),
  )
  assert(
    !displacementMapShaderSource.includes('if (impact >= maxImpact) {'),
    'the refraction map must not switch formulas at one hard radial boundary',
  )
  assert(
    blackHoleRendererSource.includes('const SCENE_REFRESH_MIN_MS = 60_000'),
    'the frozen scene should periodically refresh rather than remain stale for the full break',
  )
  assert(
    blackHoleRendererSource.includes("canvas.dataset.refreshState = 'blending'"),
    'a refreshed scene should be staged and blended without clearing the current texture',
  )
  assert(
    blackHoleRendererSource.includes('look.motion <= SCENE_REFRESH_MAX_MOTION'),
    'snapshot capture should wait for a low-motion black-hole phase',
  )
  assert(
    blackHoleRendererSource.includes('const INITIAL_SCENE_RETRY_MIN_MS = 1_000')
      && blackHoleRendererSource.includes("compositorCanvas.dataset.refreshState = 'initial-retry-wait'")
      && blackHoleRendererSource.includes('loadInitialScene()')
      && blackHoleSceneSource.includes('onReady: () => setRenderError(null)'),
    'an unavailable first snapshot should retry and clear its visible failure after recovery',
  )
  assert(
    blackHoleRendererSource.includes('if (!sceneReady) {')
      && blackHoleRendererSource.includes('completeExit()'),
    'a failed first snapshot must not prevent a bounded manual or natural exit',
  )
  assert(
    blackHoleRendererSource.includes('export const BLACK_HOLE_MANUAL_EXIT_SECONDS = 4.8'),
    'manual dismissal should leave enough time for the full evaporation curve',
  )
  assert(
    blackHoleRendererSource.includes("compositorCanvas.dataset.evaporationPhase = progress < 0.18")
      && blackHoleRendererSource.includes("? 'radiation'")
      && blackHoleRendererSource.includes('compositorCanvas.dataset.hawking = evaporation.hawking.toFixed(4)'),
    'browser checks should be able to correlate visible frames with the outward Hawking phase',
  )
  assert(
    blackHoleRendererSource.includes('const returning = exitReturnsHome'),
    'manual and natural completion should have explicit return-home behavior',
  )
  assert(
    blackHoleSceneSource.includes('elapsedSeconds,'),
    'the rest scene should pass elapsed background time into the exit animation',
  )
  assert(
    blackHoleSceneSource.includes('Math.max(0, (Date.now() - beginAt) / 1000)'),
    'returning to the foreground should resume the natural exit at its absolute-time progress',
  )
  assert(
    blackHoleRendererSource.includes('clamp(elapsedSeconds, 0, exitDuration) * 1000'),
    'the renderer should jump to the resumed evaporation progress',
  )
  assert(!blackHoleRendererSource.includes('<foreignObject'));
  assert(blackHoleRendererSource.includes('diskFeed: 1 - smoother(progress / 0.30)'));
  assert(blackHoleRendererSource.includes('float leadingShell'));
  assert(blackHoleRendererSource.includes('float trailingShell'));
  assert(blackHoleRendererSource.includes('float radialRays'));
  assert(blackHoleRendererSource.includes('radiationColor * radiation'));
  assert(blackHoleRendererSource.includes('? smoother((progress - 0.64) / 0.36)'));
  assert(blackHoleSceneSource.includes('className="code-pet-black-hole-compositor"'));
  assert(
    mainCssSource.includes(
      "body.code-mode[data-appearance='light'] .code-pet-black-hole-compositor",
    )
      && mainCssSource.includes('filter: brightness(0.88) saturate(0.92);'),
    'the light appearance should lower the frozen scene luminance so the white disk and Hawking radiation remain visible',
  );
  assert(
    mainCssSource.includes(
      "body.code-mode[data-appearance='light'] .code-pet-black-hole-canvas",
    )
      && mainCssSource.includes('brightness(0.84)')
      && mainCssSource.includes('saturate(1.28)')
      && mainCssSource.includes('drop-shadow(0 8px 20px rgba(8, 10, 9, 0.28))'),
    'the light appearance should retain a defined body silhouette without changing the dark preset',
  );

  const settingsSource = fs.readFileSync(
    path.join(__dirname, '../../src/components/code/AgentHomesSettingsPanel.tsx'),
    'utf8',
  );
  assert(settingsSource.includes("farmingPet: 'Farming Pet'"));
  assert(settingsSource.includes('code-settings-pet-rest-off-marker'));
  assert(settingsSource.includes("breakReminderOffMarker: zh ? '关闭' : 'Off'"));
  assert(settingsSource.includes('5 秒（仅用于观察效果）'));
  assert(settingsSource.includes('code-settings-pet-rest-custom'));
  assert(settingsSource.includes('code-settings-pet-appearance-options'));
  assert(settingsSource.includes('data-pet-snapshot-exclude'));
  assert(settingsSource.includes('aria-valuetext={copy.breakReminderValue(restReminderIntervalSeconds)}'));
  assert(settingsSource.includes('当前标签页内'));
  assert(settingsSource.includes("if (event.key === 'Escape')"));
  assert(settingsSource.includes('commitCustomRestReminderMinutes(event.currentTarget)'));

  const importedRestReminder = await import('../../src/lib/pet/rest-reminder.ts');
  const restReminder = importedRestReminder.default ?? importedRestReminder;
  const {
    PET_SETTINGS_STORAGE_KEY,
    PET_REST_REMINDER_RUNTIME_STORAGE_KEY,
    REST_REMINDER_BREAK_MINUTES,
    REST_REMINDER_CUSTOM_MINUTES_MAX,
    REST_REMINDER_ENTRY_COUNTDOWN_SECONDS,
    REST_REMINDER_TEST_ENTRY_COUNTDOWN_SECONDS,
    REST_REMINDER_IDLE_RESET_MS,
    REST_REMINDER_TEST_INTERVAL_SECONDS,
    createRestReminderState,
    nextRestReminderDeadline,
    normalizeRestReminderIntervalSeconds,
    readPetAppearance,
    readRestReminderRuntimeState,
    readRestReminderIntervalSeconds,
    reconfigureRestReminderInterval,
    reduceRestReminder,
    restReminderEntryCountdownSeconds,
    savePetAppearance,
    saveRestReminderRuntimeState,
    saveRestReminderIntervalSeconds,
  } = restReminder;

  assert.strictEqual(normalizeRestReminderIntervalSeconds(null), null);
  assert.strictEqual(normalizeRestReminderIntervalSeconds('5'), 5);
  assert.strictEqual(normalizeRestReminderIntervalSeconds(30 * 60), 30 * 60);
  assert.strictEqual(normalizeRestReminderIntervalSeconds(37 * 60), 37 * 60);
  assert.strictEqual(normalizeRestReminderIntervalSeconds(4 * 60 * 60), 4 * 60 * 60);
  assert.strictEqual(normalizeRestReminderIntervalSeconds(30), null);
  assert.strictEqual(
    restReminderEntryCountdownSeconds(REST_REMINDER_TEST_INTERVAL_SECONDS),
    REST_REMINDER_TEST_ENTRY_COUNTDOWN_SECONDS,
  );
  assert.strictEqual(
    restReminderEntryCountdownSeconds(50 * 60),
    REST_REMINDER_ENTRY_COUNTDOWN_SECONDS,
  );
  assert.strictEqual(
    normalizeRestReminderIntervalSeconds((REST_REMINDER_CUSTOM_MINUTES_MAX + 1) * 60),
    null,
  );

  const values = new Map();
  const storage = {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
  };
  assert.strictEqual(readRestReminderIntervalSeconds(storage), null);
  assert.strictEqual(readPetAppearance(storage), 'glass');
  assert.strictEqual(readPetAppearance(storage, 'black-hole'), 'black-hole');

  assert.strictEqual(
    saveRestReminderIntervalSeconds(
      REST_REMINDER_TEST_INTERVAL_SECONDS,
      storage,
      'black-hole',
    ),
    true,
  );
  const storedPetSettings = JSON.parse(values.get(PET_SETTINGS_STORAGE_KEY));
  assert.strictEqual(storedPetSettings.appearance, undefined);
  assert.strictEqual(readPetAppearance(storage, 'black-hole'), 'black-hole');
  assert.strictEqual(
    storedPetSettings.capabilities.restReminder.intervalSeconds,
    REST_REMINDER_TEST_INTERVAL_SECONDS,
  );
  assert.strictEqual(
    readRestReminderIntervalSeconds(storage),
    REST_REMINDER_TEST_INTERVAL_SECONDS,
  );
  assert.strictEqual(savePetAppearance('black-hole', storage), true);
  assert.strictEqual(readPetAppearance(storage), 'black-hole');
  assert.strictEqual(readPetAppearance(storage, 'glass'), 'black-hole');
  assert.strictEqual(saveRestReminderIntervalSeconds(37 * 60, storage), true);
  assert.strictEqual(readRestReminderIntervalSeconds(storage), 37 * 60);
  assert.strictEqual(readPetAppearance(storage), 'black-hole');
  assert.strictEqual(savePetAppearance('glass', storage), true);
  assert.strictEqual(
    saveRestReminderIntervalSeconds(2 * 60 * 60, storage, 'black-hole'),
    true,
  );
  assert.strictEqual(readPetAppearance(storage, 'black-hole'), 'glass');
  assert.strictEqual(saveRestReminderIntervalSeconds(30, storage), false);

  const runtimeValues = new Map();
  const runtimeStorage = {
    getItem(key) {
      return runtimeValues.get(key) ?? null;
    },
    setItem(key, value) {
      runtimeValues.set(key, value);
    },
    removeItem(key) {
      runtimeValues.delete(key);
    },
  };

  const start = 1_000_000;
  let previewState = createRestReminderState(REST_REMINDER_TEST_INTERVAL_SECONDS);
  previewState = reduceRestReminder(previewState, { type: 'activity', now: start });
  assert.strictEqual(nextRestReminderDeadline(previewState), start + 5_000);
  previewState = reduceRestReminder(previewState, { type: 'deadline', now: start + 5_000 });
  assert.strictEqual(previewState.phase, 'due');
  assert.strictEqual(
    previewState.restStartsAt,
    start + 5_000 + REST_REMINDER_TEST_ENTRY_COUNTDOWN_SECONDS * 1000,
  );
  assert.strictEqual(nextRestReminderDeadline(previewState), previewState.restStartsAt);

  const backgroundRestStartsAt = previewState.restStartsAt;
  const backgroundState = reduceRestReminder(previewState, {
    type: 'deadline',
    now: backgroundRestStartsAt + 60_000,
  });
  assert.strictEqual(backgroundState.phase, 'resting');
  assert.strictEqual(
    backgroundState.restUntil,
    backgroundRestStartsAt + REST_REMINDER_BREAK_MINUTES * 60_000,
  );
  const completedInBackgroundState = reduceRestReminder(previewState, {
    type: 'deadline',
    now: backgroundRestStartsAt + REST_REMINDER_BREAK_MINUTES * 60_000,
  });
  assert.strictEqual(completedInBackgroundState.phase, 'armed');

  let backgroundWorkState = createRestReminderState(REST_REMINDER_TEST_INTERVAL_SECONDS);
  backgroundWorkState = reduceRestReminder(backgroundWorkState, {
    type: 'activity',
    now: start,
  });
  backgroundWorkState = reduceRestReminder(backgroundWorkState, {
    type: 'deadline',
    now: start + 60_000,
  });
  assert.strictEqual(backgroundWorkState.phase, 'resting');
  assert.strictEqual(
    backgroundWorkState.restUntil,
    start
      + REST_REMINDER_TEST_INTERVAL_SECONDS * 1000
      + REST_REMINDER_TEST_ENTRY_COUNTDOWN_SECONDS * 1000
      + REST_REMINDER_BREAK_MINUTES * 60_000,
  );

  // If the browser's deadline callback is late, an actual click/keystroke still
  // wins and starts a fresh quiet window instead of allowing the overlay to
  // cover the interaction.
  const delayedActivityAt = backgroundRestStartsAt + 100;
  previewState = reduceRestReminder(previewState, {
    type: 'activity',
    now: delayedActivityAt,
  });
  assert.strictEqual(previewState.phase, 'due');
  assert.strictEqual(
    previewState.restStartsAt,
    delayedActivityAt + REST_REMINDER_TEST_ENTRY_COUNTDOWN_SECONDS * 1000,
  );

  previewState = reduceRestReminder(previewState, {
    type: 'deadline',
    now: previewState.restStartsAt,
  });
  assert.strictEqual(previewState.phase, 'resting');
  assert.strictEqual(
    previewState.restUntil,
    delayedActivityAt
      + REST_REMINDER_TEST_ENTRY_COUNTDOWN_SECONDS * 1000
      + REST_REMINDER_BREAK_MINUTES * 60_000,
  );

  let state = createRestReminderState(50 * 60);
  assert.strictEqual(state.phase, 'armed');
  assert.strictEqual(nextRestReminderDeadline(state), null);

  state = reduceRestReminder(state, { type: 'activity', now: start });
  assert.strictEqual(state.phase, 'working');
  assert.strictEqual(state.cycleStartedAt, start);
  assert.strictEqual(nextRestReminderDeadline(state), start + REST_REMINDER_IDLE_RESET_MS);

  assert.strictEqual(saveRestReminderRuntimeState(state, runtimeStorage), true);
  assert(runtimeValues.has(PET_REST_REMINDER_RUNTIME_STORAGE_KEY));
  const restoredState = readRestReminderRuntimeState(50 * 60, start + 60_000, runtimeStorage);
  assert.strictEqual(restoredState.phase, 'working');
  assert.strictEqual(restoredState.cycleStartedAt, start);
  assert.strictEqual(restoredState.lastActivityAt, start);

  const longerIntervalState = reconfigureRestReminderInterval(
    restoredState,
    60 * 60,
    start + 10 * 60_000,
  );
  assert.strictEqual(longerIntervalState.phase, 'working');
  assert.strictEqual(longerIntervalState.cycleStartedAt, start);
  assert.strictEqual(longerIntervalState.intervalSeconds, 60 * 60);

  const shorterIntervalState = reconfigureRestReminderInterval(
    longerIntervalState,
    5,
    start + 10 * 60_000,
  );
  assert.strictEqual(shorterIntervalState.phase, 'due');
  assert.strictEqual(
    shorterIntervalState.restStartsAt,
    start + 10 * 60_000 + REST_REMINDER_TEST_ENTRY_COUNTDOWN_SECONDS * 1000,
  );

  runtimeValues.set(PET_REST_REMINDER_RUNTIME_STORAGE_KEY, JSON.stringify({
    version: 1,
    state: {
      ...state,
      phase: 'due',
      restStartsAt: null,
    },
  }));
  assert.strictEqual(
    readRestReminderRuntimeState(50 * 60, start + 60_000, runtimeStorage),
    null,
  );
  assert.strictEqual(saveRestReminderRuntimeState(null, runtimeStorage), true);
  assert.strictEqual(runtimeValues.has(PET_REST_REMINDER_RUNTIME_STORAGE_KEY), false);

  state = reduceRestReminder(state, {
    type: 'activity',
    now: start + REST_REMINDER_IDLE_RESET_MS - 1,
  });
  assert.strictEqual(state.cycleStartedAt, start);
  for (let minute = 8; minute <= 48; minute += 4) {
    state = reduceRestReminder(state, {
      type: 'activity',
      now: start + minute * 60_000,
    });
  }

  state = reduceRestReminder(state, {
    type: 'deadline',
    now: start + 50 * 60_000,
  });
  assert.strictEqual(state.phase, 'due');
  assert.strictEqual(
    state.restStartsAt,
    start + 50 * 60_000 + REST_REMINDER_ENTRY_COUNTDOWN_SECONDS * 1000,
  );

  state = reduceRestReminder(state, {
    type: 'snooze',
    now: start + 50 * 60_000,
  });
  assert.strictEqual(state.phase, 'snoozed');
  assert.strictEqual(state.snoozeUsed, true);
  state = reduceRestReminder(state, {
    type: 'activity',
    now: start + 54 * 60_000,
  });
  state = reduceRestReminder(state, {
    type: 'activity',
    now: start + 58 * 60_000,
  });

  state = reduceRestReminder(state, {
    type: 'deadline',
    now: start + 60 * 60_000,
  });
  assert.strictEqual(state.phase, 'due');
  assert.strictEqual(
    state.restStartsAt,
    start + 60 * 60_000 + REST_REMINDER_ENTRY_COUNTDOWN_SECONDS * 1000,
  );
  const restStartsAt = state.restStartsAt;
  state = reduceRestReminder(state, {
    type: 'snooze',
    now: start + 60 * 60_000,
  });
  assert.strictEqual(state.phase, 'due');
  assert.strictEqual(state.restStartsAt, restStartsAt);

  state = reduceRestReminder(state, {
    type: 'deadline',
    now: state.restStartsAt,
  });
  assert.strictEqual(state.phase, 'resting');
  const restUntil = state.restUntil;

  state = reduceRestReminder(state, {
    type: 'deadline',
    now: restUntil,
  });
  assert.strictEqual(state.phase, 'armed');

  state = reduceRestReminder(state, { type: 'activity', now: start });
  state = reduceRestReminder(state, {
    type: 'activity',
    now: start + REST_REMINDER_IDLE_RESET_MS,
  });
  assert.strictEqual(state.phase, 'working');
  assert.strictEqual(state.cycleStartedAt, start + REST_REMINDER_IDLE_RESET_MS);

  console.log('Pet rest reminder tests passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
