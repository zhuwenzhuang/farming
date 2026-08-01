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
  const intentSource = fs.readFileSync(
    path.join(__dirname, '../../src/lib/pet/intents.ts'),
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
  assert(petSource.includes("disable: zh ? '不使用提醒'"));
  assert(intentSource.includes("notification: 'rest-reminder-setup'"));
  assert(petSource.includes("softGlow: zh ? '柔光'"));
  assert(petSource.includes("blackHole: zh ? '黑洞'"));
  assert(petSource.includes('它只会在需要提醒休息时出现。'));
  assert(petSource.includes("restingBody: zh ? '让眼睛和注意力暂停片刻。'"));
  assert(petSource.includes("endBreak: zh ? '结束休息' : 'End break'"));
  assert(petSource.includes("cancelBreak: zh ? '取消' : 'Cancel'"));
  assert(petSource.includes("snooze: zh ? `${REST_REMINDER_SNOOZE_MINUTES} 分钟后` : `In ${REST_REMINDER_SNOOZE_MINUTES} min`"));
  assert(petSource.includes('已连续操作 Farming {formatActivityInterval(language, intervalSeconds)}。<br />暂停操作'));
  assert(petSource.includes('className="code-pet-countdown">{countdownSeconds} 秒</strong>'));
  assert(petSource.includes('Used Farming continuously for {formatActivityInterval(language, intervalSeconds)}.<br />Pause'));
  assert(petSource.includes('className="code-pet-countdown">{countdownSeconds} sec</strong>'));
  assert(bubbleSource.includes('body: ReactNode'));
  assert(!petSource.includes('start-break'));
  assert(petSource.includes('resolvePetNotificationIntent('));
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
  assert(capabilitySource.includes("type: entryBlocked ? 'background' : 'foreground'"));
  assert(sidebarSource.includes('restReminderEntryBlocked={'));
  assert(sidebarSource.includes('|| brandDialogOpen'));
  assert(sidebarSource.includes('|| instanceNameDialogOpen'));
  assert(sidebarSource.includes('|| appModeDialogOpen'));
  assert(!sidebarSource.includes('onboardingBlocked='));
  assert(workspaceSource.includes('settingsPanelOpen'));
  assert(workspaceSource.includes('|| Boolean(mobileShareUrl)'));
  assert(workspaceSource.includes('|| Boolean(renameDialog)'));
  assert(workspaceSource.includes('|| Boolean(killDialog)'));
  assert(workspaceSource.includes('|| Boolean(deleteWorktreeDialog)'));
  assert(capabilitySource.includes("window.addEventListener('pointerdown', recordInteraction, true)"));
  assert(capabilitySource.includes('pendingInteractionAtRef'));
  assert(capabilitySource.includes('readRestReminderRuntimeState(interval)'));
  assert(capabilitySource.includes("document.addEventListener('visibilitychange', syncVisibility)"));
  assert(capabilitySource.includes('if (!pageVisible || !state) return undefined'));
  assert(petSource.includes('active={pageVisible}'));
  assert(
    petSource.includes('restReminderInvitationMs(')
      && petSource.includes('__FARMING_E2E__'),
    'the invitation timing override must stay behind the explicit E2E bridge',
  );
  assert(petSource.includes('PET_APPEARANCE_PREVIEW_EVENT'));
  assert(petSource.includes('code-pet-appearance-preview'));
  assert(petSource.includes('title={copy.previewAppearance(option)}'));
  assert(petSource.includes('<PlayGlyph />'));
  assert(mainCssSource.includes('code-pet-black-hole-disk-flow'));
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
  assert(!blackHoleSceneSource.includes('preview?: boolean'));
  assert(!blackHoleRendererSource.includes('showcasePreset'));
  assert(
    petSource.includes('restReminderBreakMinutes(previewIntervalSeconds) * 60_000')
      && !petSource.includes('PET_APPEARANCE_PREVIEW_SECONDS'),
    'appearance previews should use the complete configured break duration',
  );
  assert(blackHoleSceneSource.includes("event.key !== 'Escape'"));
  assert(!blackHoleSceneSource.includes('code-pet-close'));
  assert(blackHoleRendererSource.includes("canvas.getContext('webgl2'"));
  assert(
    blackHoleRendererSource.includes('uniform float uFilamentDetail;')
      && blackHoleRendererSource.includes(
        'const divisor = Math.max(1, Math.ceil(idealDevice / DISPLAY_CAP))',
      )
      && blackHoleRendererSource.includes(
        'filamentDetail = divisor > 1 ? 0.5 : 0.65',
      )
      && blackHoleRendererSource.includes(
        'gl.uniform1f(filamentDetailUniform, filamentDetail)',
      )
      && blackHoleRendererSource.includes(
        'float flow = mix(broadFilament, fineFilament, uFilamentDetail);',
      )
      && blackHoleRendererSource.includes(
        'rotate2d(diskPlane, swirl * 0.18) * vec2(1.9, 3.4)',
      )
      && blackHoleRendererSource.includes(
        'rotate2d(diskPlane, 1.7 + swirl * 0.10) * vec2(0.85, 1.55)',
      )
      && blackHoleRendererSource.includes(
        'float streaks = mix(0.72, 1.20 + contrast * 0.30, filament);',
      )
      && !blackHoleRendererSource.includes('wrappedNoiseAA(')
      && !blackHoleRendererSource.includes('fwidth(')
      && !blackHoleRendererSource.includes('wrappedNoise(p - 0.25'),
    'large capped accretion disks should retain two flow-aligned noise samples without radial low-frequency banding',
  )
  assert(
    !blackHoleRendererSource.includes('uniform float uLook;')
      && blackHoleRendererSource.includes('uniform float uTemperature;')
      && blackHoleRendererSource.includes('uniform float uInclination;')
      && blackHoleRendererSource.includes('uniform float uOuterRadius;')
      && blackHoleRendererSource.includes('uniform float uStarField;')
      && blackHoleRendererSource.includes('float innerRadius = uInnerRadius;')
      && blackHoleRendererSource.includes('vec3 color = blackbody(uTemperature'),
    'the lifecycle should drive the full reference preset vector instead of one Gargantua-to-Inferno scalar',
  )
  assert(
    blackHoleRendererSource.includes("phase: 'zen'")
      && blackHoleRendererSource.includes("phase: 'm87'")
      && blackHoleRendererSource.includes("phase: 'ember'")
      && blackHoleRendererSource.includes("phase: 'gargantua'")
      && blackHoleRendererSource.includes("phase: 'inferno'")
      && blackHoleRendererSource.includes("phase: 'quasar'")
      && blackHoleRendererSource.includes("phase: 'blazar'")
      && blackHoleRendererSource.includes("phase: 'cooling'")
      && blackHoleRendererSource.includes('temperature: 18000, inclination: 1.05, roll: 0.55')
      && blackHoleRendererSource.includes('innerRadius: 3, outerRadius: 10, diskOpacity: 0.3'),
    'the approved eight-state reference tour should retain a visible low-energy state instead of the diskless pure lens',
  )
  assert(
    !blackHoleRendererSource.includes("phase: 'pure-lens'")
      && blackHoleRendererSource.includes('float edge = fieldFade(pointLength);')
      && blackHoleRendererSource.includes('pointLength / (7.0 * horizon)')
      && blackHoleRendererSource.includes('radius >= ${FIELD_OUTER.toFixed(2)}')
      && blackHoleRendererSource.includes('outColor = encodeSrgb(textureGrad('),
    'the lifecycle should exclude the pure-black state without weakening the full background UI lensing field',
  )
  assert(
    !blackHoleRendererSource.includes('workAreaShield')
      && blackHoleRendererSource.includes('uniform float uPixelRatio;')
      && blackHoleRendererSource.includes('* uScale * uOpacity;')
      && blackHoleRendererSource.includes(
        'outColor = encodeSrgb(texture(uScene, sceneUv(fragment)));',
      ),
    'the compositor should preserve full-screen background lensing without a protected bottom band',
  )
  assert(
    blackHoleRendererSource.includes(
      'float shadowPixel = max(0.004, 1.25 * projection / effectiveResolution);',
    )
      && blackHoleRendererSource.includes('float shadowCoverage =')
      && blackHoleRendererSource.includes(
        'float skyBlock = mix(tracedCapture, shadowCoverage, analyticEdge);',
      ),
    'the numerical capture boundary should use analytic pixel coverage at the event-horizon edge',
  )
  assert(
    blackHoleRendererSource.includes("gl.getExtension('EXT_disjoint_timer_query_webgl2')")
      && blackHoleRendererSource.includes('canvas.dataset.gpuP95Ms = p95.toFixed(3)')
      && blackHoleRendererSource.includes('gpuFrameTimes.length > 120'),
    'E2E should expose a bounded GPU timing window for the 120 FPS frame budget',
  )
  assert(
    blackHoleRendererSource.includes('preserveDrawingBuffer: preserveForVisualRegression')
      && blackHoleRendererSource.includes("window as Window & { __FARMING_E2E__?: boolean }"),
    'pixel-level browser checks may preserve the rendered frame without changing production buffering',
  )
  assert(blackHoleRendererSource.includes('requestAnimationFrame(frame)'));
  assert(blackHoleRendererSource.includes('document.hidden'));
  assert(blackHoleRendererSource.includes('const INTRO_SECONDS = 15'));
  assert(blackHoleRendererSource.includes('const MIDDLE_CYCLE_SECONDS = 90'));
  assert(
    blackHoleRendererSource.includes('const birthVariation = seedValue(roamSeed, 0, 12)')
      && blackHoleRendererSource.includes('canvas.dataset.cycleSeconds = String(MIDDLE_CYCLE_SECONDS)')
      && blackHoleRendererSource.includes('function createEvolutionCycle(seed: number, cycleIndex: number)')
      && blackHoleRendererSource.includes('const lowEnergy = seedValue(seed, cycleIndex, 20)')
      && blackHoleRendererSource.includes('const warmDisk = seedValue(seed, cycleIndex, 21)')
      && blackHoleRendererSource.includes('const highEnergy = seedValue(seed, cycleIndex, 22)')
      && blackHoleRendererSource.includes(
        'return [...lowEnergy, ...warmDisk, inferno, ...highEnergy, cooling] as const',
      )
      && blackHoleRendererSource.includes('const nextCycle = createEvolutionCycle(evolutionSeed, cycleIndex + 1)')
      && blackHoleRendererSource.includes('? nextCycle[0]')
      && blackHoleRendererSource.includes('canvas.dataset.cycleOrder = firstCycle.map')
      && blackHoleRendererSource.includes('canvas.dataset.birthPreset = birthTarget.phase'),
    'each 90-second cycle should follow a constrained low-to-high-to-cooling route and blend into the next randomized route',
  );
  assert(blackHoleRendererSource.includes('export const BLACK_HOLE_EXIT_SECONDS = 15'));
  assert(
    blackHoleRendererSource.includes('export const BLACK_HOLE_HOME_ATTRACTION_SECONDS = 60')
      && blackHoleSceneSource.includes('rendererRef.current?.setRestUntil(restUntil)'),
    'the renderer should receive the live rest deadline for the final-minute attraction',
  );
  assert(blackHoleRendererSource.includes('crypto.getRandomValues'));
  assert(blackHoleRendererSource.includes('createCompositorRenderer'));
  assert(blackHoleRendererSource.includes('createSceneImage'));
  assert(blackHoleRendererSource.includes("await import('@zumer/snapdom')"));
  assert(blackHoleRendererSource.includes('createXtermSnapshotOverlays'));
  assert(blackHoleRendererSource.includes("excludeMode: 'remove'"));
  assert(blackHoleRendererSource.includes("'browser-mcp-container'"));
  assert(blackHoleRendererSource.includes("highMap\n    .getContext('webgl2')"));
  assert(blackHoleRendererSource.includes("lowMap\n    .getContext('webgl2')"));
  assert(blackHoleRendererSource.includes('canvas.dataset.captureMs'));
  assert(blackHoleRendererSource.includes('PET_SNAPSHOT_EXCLUDE_SELECTORS'));
  assert(blackHoleRendererSource.includes('plugins: [snapshotPlugin]'));
  assert(blackHoleRendererSource.includes('image.dataset.remainingPetElements'));
  assert(
    blackHoleRendererSource.includes("const FILE_ICON_SELECTOR = 'img.code-file-type-icon'")
      && blackHoleRendererSource.includes('function rasterizeVisibleFileIcons()')
      && blackHoleRendererSource.includes("canvas.toDataURL('image/png')")
      && blackHoleRendererSource.includes('image.src = rasterizedSource')
      && blackHoleRendererSource.includes('image.dataset.rasterizedFileIcons'),
    'the scene snapshot should rasterize loaded file SVGs before cloning them',
  );
  assert(
    blackHoleRendererSource.includes('writeMap(\n    displacement * ${DISPLAY_SIZE.toFixed(1)},\n    edge\n  );'),
    'the displacement map should retain the full smooth field without a second blur control',
  )
  assert(
    blackHoleRendererSource.includes('textureGrad(')
      && blackHoleRendererSource.includes("gl.getExtension('EXT_texture_filter_anisotropic')")
      && blackHoleRendererSource.includes('gl.SRGB8_ALPHA8')
      && blackHoleRendererSource.includes('gl.LINEAR_MIPMAP_LINEAR'),
    'the production compositor should filter the sRGB plate in linear light with an anisotropic mapping footprint',
  )
  assert(
    blackHoleRendererSource.includes('premultipliedAlpha: true')
      && !blackHoleRendererSource.includes('RENDER_SCALE')
      && blackHoleRendererSource.includes('uniform float uFieldScale;')
      && blackHoleRendererSource.includes('canvasCssSize: () => number')
      && blackHoleRendererSource.includes('canvas.style.transform ='),
    'the disk should composite premultiplied radiance and move on an exact-ratio backing store without per-frame layout',
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
    !blackHoleRendererSource.includes('SCENE_REFRESH')
      && !blackHoleRendererSource.includes('refreshScene')
      && !blackHoleRendererSource.includes('transitionScene'),
    'the black hole should keep its initial scene instead of blocking animation with periodic DOM snapshots',
  )
  assert(
    blackHoleRendererSource.includes('const INITIAL_SCENE_RETRY_MIN_MS = 1_000')
      && blackHoleRendererSource.includes("compositorCanvas.dataset.refreshState = 'initial-retry-wait'")
      && blackHoleRendererSource.includes('loadInitialScene()')
      && blackHoleSceneSource.includes('onReady: () => setRenderError(null)'),
    'an unavailable first snapshot should retry and clear its visible failure after recovery',
  )
  assert(
    blackHoleRendererSource.includes('const backgroundColor = getComputedStyle(document.body).backgroundColor')
      && blackHoleRendererSource.includes('embedFonts: true')
      && blackHoleRendererSource.includes('const clonedBodyBackground = backgroundColor')
      && blackHoleRendererSource.includes('image.dataset.clonedBodyBackground = clonedBodyBackground'),
    'the production snapshot should retain the current appearance background and embedded fonts',
  )
  assert(
    !blackHoleRendererSource.includes('|| (!sceneReady && exitingAt === null)')
      && blackHoleRendererSource.includes('if (sceneReady) compositor.draw(pose)')
      && blackHoleRendererSource.includes('completeExit()'),
    'the black hole and its bounded exit must render independently from the scene snapshot',
  )
  assert(
    blackHoleRendererSource.includes('export const BLACK_HOLE_MANUAL_EXIT_SECONDS = 4.8'),
    'manual dismissal should leave enough time for the full evaporation curve',
  )
  assert(
    blackHoleRendererSource.includes("compositorCanvas.dataset.evaporationPhase = progress < 0.20")
      && blackHoleRendererSource.includes("? 'blue-shift'")
      && blackHoleRendererSource.includes("? 'photon-collapse'")
      && blackHoleRendererSource.includes(": 'final-release'")
      && blackHoleRendererSource.includes('compositorCanvas.dataset.hawking = evaporation.hawking.toFixed(4)'),
    'browser checks should be able to correlate visible frames with each bounded exit phase',
  )
  assert(
    blackHoleRendererSource.includes('const returning = exitReturnsHome'),
    'manual and natural completion should have explicit return-home behavior',
  )
  assert(
    blackHoleRendererSource.includes('canvas.dataset.homeAttraction = homeAttraction.toFixed(4)')
      && blackHoleRendererSource.includes('homeElement,\n      homeAttraction,')
      && blackHoleRendererSource.includes('? smoother(progress)')
      && !blackHoleRendererSource.includes('? smoother((progress - 0.80) / 0.14)'),
    'the home position should attract the black hole before evaporation and continue smoothly through exit',
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
  assert(
    blackHoleRendererSource.includes('const remainingBody = Math.max(0, 1 - smoother(progress))')
      && blackHoleRendererSource.includes(
        'diskFeed: Math.sqrt(Math.max(0, 1 - smoother(progress / 0.94)))',
      )
      && blackHoleRendererSource.includes('hawking: smoother((progress - 0.12) / 0.78)'),
    'the disk and body should evaporate continuously while the thermal ring develops',
  );
  assert(
    blackHoleRendererSource.includes('body: remainingBody ** 0.35')
      && blackHoleRendererSource.includes('lens: remainingBody')
      && blackHoleRendererSource.includes(
        'compositorCanvas.dataset.diskFeed = evaporation.diskFeed.toFixed(4)',
      ),
    'the full black-hole presentation should fade continuously instead of disappearing at the final frame',
  );
  assert(blackHoleRendererSource.includes('float photonRing'));
  assert(blackHoleRendererSource.includes('float secondaryRing'));
  assert(blackHoleRendererSource.includes('float echoRing'));
  assert(blackHoleRendererSource.includes('float flashEnvelope'));
  assert(!blackHoleRendererSource.includes('float radialRays'));
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
      && mainCssSource.includes('saturate(1.28)'),
    'the light appearance should retain a defined body silhouette without changing the dark preset',
  );
  assert(
    mainCssSource.includes('will-change: transform, opacity;')
      && !mainCssSource.includes('drop-shadow(0 7px 16px rgba(8, 10, 9, 0.16))')
      && !mainCssSource.includes('drop-shadow(0 8px 20px rgba(8, 10, 9, 0.28))'),
    'the moving disk should stay on the compositor and avoid a full-canvas blur pass',
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
  assert(settingsSource.includes('code-settings-pet-appearance-preview'));
  assert(settingsSource.includes('onPreviewPetAppearance(option)'));
  assert(settingsSource.includes('data-pet-snapshot-exclude'));
  assert(settingsSource.includes('aria-valuetext={copy.breakReminderValue(displayedRestReminderIntervalSeconds)}'));
  assert(settingsSource.includes('按本页前台可见时间计时'));
  assert(settingsSource.includes('value={restReminderSliderValue}'));
  assert(settingsSource.includes('step="any"'));
  assert(settingsSource.includes('REST_REMINDER_INTERVAL_PRESETS_SECONDS.length - 1'));
  assert(settingsSource.includes('restReminderSliderIntervalSeconds(value)'));
  assert(settingsSource.includes('onChange={event => setRestReminderSliderValue(Number(event.target.value))}'));
  assert(settingsSource.includes('onPointerUp={commitRestReminderSliderValue}'));
  assert(settingsSource.includes('onPointerUp={commitContentFontSize}'));
  assert(settingsSource.includes('onPointerUp={commitSearchTimeout}'));
  assert(settingsSource.includes('onChange={event => setCustomRestReminderMinutes(event.currentTarget.value)}'));

  const importedRestReminder = await import('../../src/lib/pet/rest-reminder.ts');
  const restReminderModule = importedRestReminder as typeof importedRestReminder & {
    default?: typeof importedRestReminder;
  };
  const restReminder = restReminderModule.default ?? importedRestReminder;
  const importedPetIntents = await import('../../src/lib/pet/intents.ts');
  const petIntentsModule = importedPetIntents as typeof importedPetIntents & {
    default?: typeof importedPetIntents;
  };
  const petIntents = petIntentsModule.default ?? importedPetIntents;
  const {
    PET_SETTINGS_STORAGE_KEY,
    PET_REST_REMINDER_RUNTIME_STORAGE_KEY,
    REST_REMINDER_BREAK_MINUTES,
    REST_REMINDER_LONG_BREAK_MINUTES,
    REST_REMINDER_CUSTOM_MINUTES_MAX,
    REST_REMINDER_ENTRY_COUNTDOWN_SECONDS,
    REST_REMINDER_TEST_ENTRY_COUNTDOWN_SECONDS,
    REST_REMINDER_IDLE_RESET_MS,
    REST_REMINDER_INTERVAL_PRESETS_SECONDS,
    REST_REMINDER_TEST_INTERVAL_SECONDS,
    createRestReminderState,
    nextRestReminderDeadline,
    normalizeRestReminderIntervalSeconds,
    restReminderSliderIntervalSeconds,
    restReminderSliderPosition,
    readPetAppearance,
    readRestReminderRuntimeState,
    readRestReminderIntervalSeconds,
    reconfigureRestReminderInterval,
    reduceRestReminder,
    restReminderBreakMinutes,
    restReminderEntryCountdownSeconds,
    restReminderInvitationMs,
    savePetAppearance,
    saveRestReminderRuntimeState,
    saveRestReminderIntervalSeconds,
  } = restReminder;
  const { resolvePetNotificationIntent } = petIntents;

  assert.strictEqual(normalizeRestReminderIntervalSeconds(null), null);
  assert.strictEqual(normalizeRestReminderIntervalSeconds('5'), 5);
  assert.strictEqual(normalizeRestReminderIntervalSeconds(30 * 60), 30 * 60);
  assert.strictEqual(normalizeRestReminderIntervalSeconds(37 * 60), 37 * 60);
  assert.strictEqual(normalizeRestReminderIntervalSeconds(4 * 60 * 60), 4 * 60 * 60);
  assert.strictEqual(normalizeRestReminderIntervalSeconds(30), null);
  assert.strictEqual(restReminderSliderPosition(0), 0);
  assert.strictEqual(
    restReminderSliderPosition(REST_REMINDER_TEST_INTERVAL_SECONDS),
    1,
  );
  assert.strictEqual(restReminderSliderPosition(37 * 60), 3.7);
  assert.strictEqual(restReminderSliderIntervalSeconds(3.4), 30 * 60);
  assert.strictEqual(restReminderSliderIntervalSeconds(3.6), 40 * 60);
  assert.strictEqual(
    restReminderSliderIntervalSeconds(REST_REMINDER_INTERVAL_PRESETS_SECONDS.length - 1),
    90 * 60,
  );
  assert.strictEqual(restReminderBreakMinutes(50 * 60), REST_REMINDER_BREAK_MINUTES);
  assert.strictEqual(restReminderBreakMinutes(90 * 60), REST_REMINDER_LONG_BREAK_MINUTES);
  assert.strictEqual(
    restReminderEntryCountdownSeconds(REST_REMINDER_TEST_INTERVAL_SECONDS),
    REST_REMINDER_TEST_ENTRY_COUNTDOWN_SECONDS,
  );
  assert.strictEqual(
    restReminderEntryCountdownSeconds(50 * 60),
    REST_REMINDER_ENTRY_COUNTDOWN_SECONDS,
  );
  assert.strictEqual(restReminderInvitationMs(''), 30 * 60_000);
  assert.strictEqual(restReminderInvitationMs('?petRestInvitationSeconds=30'), 30 * 60_000);
  assert.strictEqual(restReminderInvitationMs('?petRestInvitationSeconds=30', true), 30_000);
  assert.strictEqual(restReminderInvitationMs('?petRestInvitationSeconds=0', true), 30 * 60_000);
  assert.strictEqual(restReminderInvitationMs('?petRestInvitationSeconds=1801', true), 30 * 60_000);
  assert.strictEqual(
    normalizeRestReminderIntervalSeconds((REST_REMINDER_CUSTOM_MINUTES_MAX + 1) * 60),
    null,
  );
  assert.deepStrictEqual(resolvePetNotificationIntent(null, null), {
    kind: 'notification',
    notification: 'rest-reminder-setup',
    option: 'invitation',
  });
  assert.strictEqual(resolvePetNotificationIntent(0, null), null);
  assert.strictEqual(resolvePetNotificationIntent(50 * 60, null), null);
  assert.deepStrictEqual(resolvePetNotificationIntent(50 * 60, 'appearance'), {
    kind: 'notification',
    notification: 'rest-reminder-setup',
    option: 'appearance',
  });

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
  previewState = reduceRestReminder(previewState, { type: 'foreground', now: start });
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
    type: 'foreground',
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
    type: 'interaction',
    now: delayedActivityAt,
  });
  assert.strictEqual(previewState.phase, 'due');
  assert.strictEqual(
    previewState.restStartsAt,
    delayedActivityAt + REST_REMINDER_TEST_ENTRY_COUNTDOWN_SECONDS * 1000,
  );

  let delayedWorkingState = createRestReminderState(REST_REMINDER_TEST_INTERVAL_SECONDS);
  delayedWorkingState = reduceRestReminder(delayedWorkingState, {
    type: 'foreground',
    now: start,
  });
  delayedWorkingState = reduceRestReminder(delayedWorkingState, {
    type: 'interaction',
    now: start + REST_REMINDER_TEST_INTERVAL_SECONDS * 1000 + 100,
  });
  assert.strictEqual(delayedWorkingState.phase, 'due');
  assert.strictEqual(
    delayedWorkingState.restStartsAt,
    start
      + REST_REMINDER_TEST_INTERVAL_SECONDS * 1000
      + 100
      + REST_REMINDER_TEST_ENTRY_COUNTDOWN_SECONDS * 1000,
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

  state = reduceRestReminder(state, { type: 'foreground', now: start });
  assert.strictEqual(state.phase, 'working');
  assert.strictEqual(state.cycleStartedAt, start);
  assert.strictEqual(nextRestReminderDeadline(state), start + 50 * 60_000);

  assert.strictEqual(saveRestReminderRuntimeState(state, runtimeStorage), true);
  assert(runtimeValues.has(PET_REST_REMINDER_RUNTIME_STORAGE_KEY));
  const restoredState = readRestReminderRuntimeState(50 * 60, start + 60_000, runtimeStorage);
  assert.strictEqual(restoredState.phase, 'working');
  assert.strictEqual(restoredState.cycleStartedAt, start);
  assert.strictEqual(restoredState.backgroundedAt, null);

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
    type: 'interaction',
    now: start + 54 * 60_000,
  });
  state = reduceRestReminder(state, {
    type: 'interaction',
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

  state = reduceRestReminder(state, { type: 'foreground', now: start });
  state = reduceRestReminder(state, {
    type: 'background',
    now: start + 10 * 60_000,
  });
  assert.strictEqual(nextRestReminderDeadline(state), null);
  state = reduceRestReminder(state, {
    type: 'foreground',
    now: start + 12 * 60_000,
  });
  assert.strictEqual(state.phase, 'working');
  assert.strictEqual(state.cycleStartedAt, start + 2 * 60_000);
  state = reduceRestReminder(state, {
    type: 'background',
    now: start + 20 * 60_000,
  });
  state = reduceRestReminder(state, {
    type: 'foreground',
    now: start + 20 * 60_000 + REST_REMINDER_IDLE_RESET_MS,
  });
  assert.strictEqual(state.cycleStartedAt, start + 20 * 60_000 + REST_REMINDER_IDLE_RESET_MS);

  console.log('Pet rest reminder tests passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
