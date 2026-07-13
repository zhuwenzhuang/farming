const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
  const terminalBridgePath = path.join(__dirname, '../../frontend/terminal-bridge.js');
  const skinBridgePath = path.join(__dirname, '../../frontend/skin-bridge.js');
  const runtimePathsPath = path.join(__dirname, '../../frontend/runtime-paths.js');
  const sessionBridgePath = path.join(__dirname, '../../frontend/session-bridge.js');
  const indexHtmlPath = path.join(__dirname, '../../frontend/skins/crt/index.html');
  const effectsCssPath = path.join(__dirname, '../../frontend/skins/crt/styles/effects.css');
  const monochromeCssPath = path.join(__dirname, '../../frontend/skins/crt/styles/monochrome-green.css');
  const departureFontPath = path.join(__dirname, '../../frontend/skins/crt/assets/fonts/departure-mono/DepartureMonoNerdFontMono-Regular.otf');
  const departureLicensePath = path.join(__dirname, '../../frontend/skins/crt/assets/fonts/departure-mono/LICENSE');
  const crtIconPath = path.join(__dirname, '../../frontend/skins/crt/assets/branding/farming-crt-icon.svg');
  const pkgConfigPath = path.join(__dirname, '../../pkg.config.cjs');
  const serverPath = path.join(__dirname, '../../backend/server.js');

  const terminalBridge = fs.readFileSync(terminalBridgePath, 'utf8');
  const skinBridge = fs.readFileSync(skinBridgePath, 'utf8');
  const runtimePaths = fs.readFileSync(runtimePathsPath, 'utf8');
  const sessionBridge = fs.readFileSync(sessionBridgePath, 'utf8');
  const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
  const effectsCss = fs.readFileSync(effectsCssPath, 'utf8');
  const monochromeCss = fs.readFileSync(monochromeCssPath, 'utf8');
  const crtIcon = fs.readFileSync(crtIconPath, 'utf8');
  const pkgConfig = fs.readFileSync(pkgConfigPath, 'utf8');
  const server = fs.readFileSync(serverPath, 'utf8');
  const crtApp = fs.readFileSync(path.join(__dirname, '../../frontend/skins/crt/app.js'), 'utf8');

  assert(
    terminalBridge.includes('FarmingTerminalBridge'),
    'terminal bridge should attach a global bridge object'
  );
  assert(terminalBridge.includes('createInstance'), 'terminal bridge should expose terminal creation');
  assert(terminalBridge.includes("kind: 'xterm'"), 'terminal bridge should default to the stable xterm renderer');
  assert(terminalBridge.includes("=== 'ghostty'"), 'terminal bridge should retain Ghostty as an explicit debug override');
  assert(
    terminalBridge.includes('Ghostty terminal is unavailable'),
    'terminal bridge should fail explicitly when ghostty is unavailable'
  );
  assert(
    skinBridge.includes('FarmingSkinBridge'),
    'skin bridge should attach a global bridge object'
  );
  assert(skinBridge.includes('getSessionSkin'), 'skin bridge should expose session skin resolution');
  assert(runtimePaths.includes('FarmingRuntimePaths'), 'CRT runtime should expose base-path-aware URLs');
  assert(
    sessionBridge.includes('sendComposerMessage(agentId, message, attachments = [])') &&
      sessionBridge.includes('...(attachments.length > 0 ? { attachments } : {})'),
    'structured runtimes should preserve native ACP prompt attachments through the session bridge'
  );
  assert(runtimePaths.includes("path('/ws')"), 'CRT runtime should connect to the base-path WebSocket');
  assert(
    indexHtml.indexOf('runtime-paths.js') < indexHtml.indexOf('terminal-bridge.js'),
    'CRT runtime paths should load before frontend bridges'
  );
  assert(indexHtml.includes('../vendor/xterm/xterm.js'), 'CRT should load the shared xterm browser runtime');
  assert(indexHtml.includes('../vendor/xterm/addon-fit.js'), 'CRT should load the xterm fit addon');
  assert(indexHtml.includes('../vendor/xterm/addon-webgl.js'), 'CRT should load the xterm WebGL addon');
  assert(!indexHtml.includes('effects/crt-webgl-effects.js'), 'CRT terminal input should not load a cross-context full-canvas feedback engine');
  assert(indexHtml.includes('../vendor/xterm/xterm.css'), 'CRT should load the xterm stylesheet');
  assert(pkgConfig.includes("node_modules/@xterm/xterm/lib/xterm.js"), 'standalone packages should include the CRT xterm runtime');
  assert(pkgConfig.includes("node_modules/@xterm/addon-fit/lib/addon-fit.js"), 'standalone packages should include the CRT fit addon');
  assert(pkgConfig.includes("node_modules/@xterm/addon-webgl/lib/addon-webgl.js"), 'standalone packages should include the CRT WebGL addon');
  assert(
    indexHtml.indexOf('xterm/xterm.js') < indexHtml.indexOf('terminal-bridge.js'),
    'xterm should load before the CRT terminal bridge'
  );
  assert(
    effectsCss.includes('repeating-linear-gradient('),
    'CRT effects should include visible static scanlines'
  );
  assert(
    effectsCss.includes('background-size: 100% 3px') && !effectsCss.includes('crt-scanline-drift'),
    'CRT scanlines should use a static three-pixel phosphor raster without compositor drift'
  );
  assert(!effectsCss.includes('mix-blend-mode: multiply'), 'CRT static scanlines should not force full-screen blend recomposition');
  assert(indexHtml.includes('class="crt-scan-beam"'), 'CRT entry should render the lightweight scan beam');
  assert(indexHtml.includes('class="crt-phosphor-noise"'), 'CRT entry should render one shared procedural phosphor noise layer');
  assert(!indexHtml.includes('class="crt-scan-afterglow"'), 'CRT entry should not retain a separate cumulative afterglow layer');
  assert(effectsCss.includes('animation: crt-scan-beam-cycle 6.8s linear infinite'), 'CRT beam should follow the quiet continuous reference cycle');
  assert(effectsCss.includes('height: 300px'), 'CRT scan should use the reference-shaped 300px phosphor trail');
  assert(effectsCss.includes('rgba(12, 204, 104, 0.04) 100%'), 'CRT scan trail should keep its peak at the low reference intensity');
  assert(!effectsCss.includes('.crt-scan-beam::after'), 'CRT scan should not add a separate attention-grabbing line head');
  assert(!effectsCss.includes('#farming-crt.session-open .crt-scan-beam'), 'CRT scan should remain a whole-screen surface effect in opened sessions');
  assert(!effectsCss.includes('#farming-crt:not(.no-crt)::after'), 'CRT should not darken the viewport edges with a vignette');
  assert(effectsCss.includes('phosphor-noise.svg'), 'CRT screen surface should retain its original static noise texture');
  assert(effectsCss.includes('crt-content-afterimage 620ms'), 'CRT content changes should leave a short phosphor afterimage');
  assert(crtApp.includes('appendCrtPreviewAfterimage'), 'CRT previews should use event-driven phosphor decay');
  assert(indexHtml.includes('id="crt-structured-composer"'), 'CRT should expose a native composer for structured Agent runtimes');
  assert(!indexHtml.includes('crt-structured-input-prompt') && !indexHtml.includes('MESSAGE&gt;'), 'CRT structured input should not spend horizontal space on a redundant prompt label');
  assert(indexHtml.includes('id="crt-structured-input" rows="2"') && crtApp.includes('resizeStructuredComposerInput'), 'CRT structured input should grow to show multiline drafts');
  assert(crtApp.includes('focusStructuredComposerToolbarButton') && crtApp.includes('focusStructuredComposerMenuButton'), 'CRT structured Composer should support layered keyboard navigation from the draft into inline controls');
  assert(crtApp.includes('structuredComposerConfigId') && crtApp.includes('structuredConfigValueLabel'), 'CRT structured config should reveal categories before their individual values');
  assert(crtApp.includes('structuredVisibleConfigOptions') && crtApp.includes("String(option && option.id || '').toLowerCase() !== 'mode'"), 'CRT structured config should not repeat the ACP mode control');
  assert(crtApp.includes('backStructuredComposerMenu'), 'CRT structured config should return one keyboard level at a time');
  assert(indexHtml.indexOf('id="crt-structured-composer-toolbar"') < indexHtml.indexOf('id="crt-structured-composer-menu"'), 'CRT structured control menus should expand below the toolbar');
  assert(indexHtml.includes('.crt-structured-menu-item:hover small') && indexHtml.includes('.crt-structured-menu-item:focus-visible small') && indexHtml.includes('-webkit-line-clamp: 2'), 'CRT selected menu descriptions should stay compact and use readable reverse-video text for mouse and keyboard selection');
  assert(indexHtml.includes('#farming-crt #crt-structured-send:disabled') && indexHtml.includes('background: rgba(0, 28, 12, 0.7)'), 'CRT structured Send should use a phosphor command state instead of the browser-native disabled button');
  assert(indexHtml.includes('#crt-structured-send[data-action="interrupt"]'), 'CRT structured Send should retain a distinct interrupt command state');
  assert(crtApp.includes('structuredComposerCompositionEndAt'), 'CRT structured input should not submit the Enter used to confirm an IME composition');
  assert(crtApp.includes('navigateStructuredComposerHistory') && crtApp.includes('structuredComposerHistory'), 'CRT structured input should provide terminal-style draft history');
  assert(indexHtml.includes('.terminal.crt-structured-session::-webkit-scrollbar-thumb') && indexHtml.includes('background-clip: content-box'), 'CRT structured Chat should expose only a narrow phosphor scroll indicator over a wider native hit target');
  assert(crtApp.includes('focusStructuredTranscript') && crtApp.includes("status.dataset.scrollHint") && crtApp.includes("'[TAB] SCROLL'"), 'CRT structured Chat should disclose and enter keyboard scrolling only when the transcript overflows');
  assert(crtApp.includes("event.key === 'ArrowUp' || event.key === 'ArrowDown'") && crtApp.includes('transcript.clientHeight * 0.85'), 'CRT structured Chat should scroll by viewport using universal arrow keys');
  assert(crtApp.includes('structuredComposerPendingFollowUps') && crtApp.includes('queueStructuredComposerFollowUp'), 'CRT ACP Composer should queue follow-up messages instead of treating a second Enter as interrupt');
  assert(crtApp.includes('structuredComposerRestoreFocusAfterInterrupt') && crtApp.includes('requestAnimationFrame(() => input.focus())'), 'CRT structured input should restore focus after an interrupt reaches a stable runtime state');
  assert(indexHtml.includes('id="crt-structured-attach"') && crtApp.includes('prepareStructuredAttachment'), 'CRT structured input should attach image and text context through the shared attachment format');
  assert(indexHtml.includes('id="crt-structured-command"') && crtApp.includes('availableCommands'), 'CRT structured input should expose ACP slash commands');
  assert(crtApp.includes("target.closest('#crt-structured-composer')"), 'CRT global clipboard handlers should leave structured input copy and paste native');
  assert(crtApp.includes('renderStructuredPermissions') && crtApp.includes('/acp-permission'), 'CRT structured input should surface ACP permission requests beside the prompt');
  assert(crtApp.includes('isStructuredRuntimeAgent') && crtApp.includes('sendComposerMessage'), 'CRT should not route ACP, JSON, or App Server Agents through PTY input');
  assert(indexHtml.includes('id="crt-runtime-toggle"') && indexHtml.includes('class="crt-runtime-glyph" aria-hidden="true">MSG</span>') && indexHtml.includes('class="crt-runtime-glyph" aria-hidden="true">TTY</span>'), 'CRT should expose retro MSG and TTY runtime controls');
  assert(crtApp.includes("body: JSON.stringify({ agentRuntimeMode: targetMode })"), 'CRT runtime controls should use the backend restart path');
  assert(crtApp.includes('isCrtRuntimeSwitchShortcut') && indexHtml.includes('class="crt-command-shortcut" aria-hidden="true">[ALT+M]</span>'), 'CRT should expose a visible non-terminal runtime switch shortcut');
  assert(indexHtml.includes('class="kill-btn" aria-label="Kill Agent, Ctrl+K"') && indexHtml.includes('class="close-btn" aria-label="Close session, Ctrl+Escape"'), 'CRT Kill and Close should retain their standalone button styles');
  assert(indexHtml.includes('>KILL [CTRL+K]</button>') && indexHtml.includes('>CLOSE [CTRL+ESC]</button>'), 'CRT session actions should default to the Terminal keyboard labels');
  assert(crtApp.includes('function updateCrtSessionCloseControl(agent)') && crtApp.includes("chat ? 'CLOSE [ESC]' : 'CLOSE [CTRL+ESC]'"), 'CRT should show Escape for Chat and Ctrl+Escape for Terminal');
  assert(crtApp.includes('structuredSessionActive') && crtApp.includes('(e.ctrlKey || e.metaKey || !structuredComposerMenu)'), 'CRT structured sessions should close with Escape or Ctrl+Escape while preserving submenu back navigation');
  assert(indexHtml.includes('#farming-crt .session-header-actions > .kill-btn') && indexHtml.includes('height: 38px;') && indexHtml.includes('font-size: 16px;'), 'CRT session header controls should share one height and type size');
  assert(crtApp.includes("document.addEventListener('keydown', (event) => {") && crtApp.includes('}, true);'), 'CRT should capture the runtime shortcut before xterm sends it to the PTY');
  assert(crtApp.includes('[READ ONLY]') && terminalBridge.includes('disableStdin'), 'CRT should make exited terminal sessions explicitly read-only');
  assert(crtApp.includes('CRT_PREVIEW_RENDER_INTERVAL_MS = 1000'), 'CRT dashboard previews should batch to at most one visual update per second');
  assert(crtApp.includes('scheduleCrtPreviewCardRender') && crtApp.includes('dashboardRenderDeferred'), 'CRT should target changed cards and defer dashboard rendering behind an open terminal');
  assert(!crtApp.includes('drawImage('), 'CRT terminal output must not copy xterm canvases on the typing path');
  assert(terminalBridge.includes('new WebglAddon()'), 'CRT should use xterm\'s disposable WebGL framebuffer for low-latency input');
  assert(!terminalBridge.includes('new WebglAddon(true)'), 'CRT should not preserve xterm\'s drawing buffer for post-processing');
  assert(!crtApp.includes('pulseSessionTerminalPhosphor'), 'CRT terminal output must not animate the xterm screen on the typing path');
  assert(!effectsCss.includes('crt-phosphor-noise-shift'), 'CRT phosphor noise should remain static to avoid continuous full-screen compositing');
  assert(effectsCss.includes('#farming-crt.page-hidden .crt-scan-beam'), 'CRT should pause the scan beam while its page is hidden');
  assert(crtApp.includes("document.addEventListener('visibilitychange'") && crtApp.includes("window.addEventListener('pagehide'"), 'CRT should observe page visibility lifecycle events');
  assert(crtApp.includes('suspendCrtPageConnection') && crtApp.includes('wsReconnectTimer'), 'CRT should close hidden-page sockets and cancel reconnect work');
  assert(crtApp.includes('resumeCrtPageConnection') && crtApp.includes('refreshSessionView(true, activeAgentId'), 'CRT should reconnect and resync the focused terminal when visible again');
  assert(!effectsCss.includes('repeating-linear-gradient(\n            to right'), 'Monochrome Green should not use an RGB aperture mask');
  assert(indexHtml.includes('id="farming-crt"'), 'CRT effects should be scoped to the CRT skin root');
  assert(indexHtml.includes('rel="icon" type="image/svg+xml" href="assets/branding/farming-crt-icon.svg"'), 'CRT should use its terminal-computer brand mark as the page icon');
  assert(crtIcon.includes('<title>FARMING CRT</title>') && crtIcon.includes('>CRT</text>'), 'CRT page icon should expose the complete brand name and retain a visible CRT wordmark');
  assert(indexHtml.includes('styles/effects.css'), 'CRT entry should load its private effects stylesheet');
  assert(indexHtml.includes('styles/monochrome-green.css'), 'CRT entry should load its private Monochrome Green stylesheet');
  assert(fs.existsSync(departureFontPath), 'CRT should bundle the Departure Mono font');
  assert(fs.readFileSync(departureLicensePath, 'utf8').includes('SIL OPEN FONT LICENSE Version 1.1'), 'CRT should retain the Departure Mono license');
  assert(monochromeCss.includes('font-family: "Departure Mono CRT"'), 'CRT should use Departure Mono for its interface');
  assert(monochromeCss.includes('"PingFang SC"') && monochromeCss.includes('"Noto Sans Mono CJK SC"'), 'CRT should retain readable CJK font fallbacks');
  assert(crtApp.includes('FarmingTerminalBridge.DEFAULT_FONT_FAMILY'), 'CRT terminal output should use the shared mixed-language font stack');
  assert(
    crtApp.includes('DEFAULT_TERMINAL_FONT_SIZE = 15') &&
      crtApp.includes('MIN_TERMINAL_FONT_SIZE = 10') &&
      crtApp.includes('MAX_TERMINAL_FONT_SIZE = 20') &&
      crtApp.includes('normalizeCrtTerminalFontSize'),
    'CRT terminal density should default to Farming Code while keeping the configured size bounded'
  );
  assert(crtApp.includes('TERMINAL_SCROLLBACK = 5000'), 'CRT terminal scrollback should match Farming Code');
  assert(crtApp.includes('imeEnabled: false'), 'CRT should use xterm native input like Farming Code');
  assert(crtApp.includes("if (!SESSION_INPUT_SETTINGS.imeEnabled) {\n        return;\n      }"), 'CRT native input should not also route terminal keys through the legacy document handler');
  assert(crtApp.includes("querySelector('.xterm-screen')") && crtApp.includes('activeBuffer.cursorX'), 'CRT should retain its fallback IME positioning implementation');
  assert(!crtApp.includes('terminal.onCursorMove(syncTerminalInputBridgePosition)'), 'CRT typing must not force input-bridge layout on every cursor echo');
  assert(crtApp.includes('}, 0)\n  };\n  terminalInputPendingTexts.push(pending);'), 'CRT printable fallback should not add a fixed per-character delay');
  assert(crtApp.includes("RUNTIME_PATHS.path('/code/')"), 'CRT UI Theme settings should provide a Farming Code return path');
  assert(crtApp.includes("displayName: 'Farming Code'"), 'CRT UI Theme settings should show Farming Code');
  assert(crtApp.includes('renderCrtTerminalSnapshot(outputTail, agent.previewSnapshot)'), 'CRT previews should preserve terminal snapshot colors');
  assert(crtApp.includes("data.type === 'session-preview'") && crtApp.includes('terminalPreviewSnapshots.set'), 'CRT should consume backend color preview snapshots');
  assert(monochromeCss.includes('font-family: var(--crt-terminal-font)'), 'CRT Agent previews should use the readable terminal font stack');
  assert(
    monochromeCss.includes('#farming-crt #session-modal {') &&
      monochromeCss.includes('padding: 7px;') &&
      monochromeCss.includes('background: var(--crt-background);') &&
      monochromeCss.includes('#farming-crt #session-modal .modal-content') &&
      monochromeCss.includes('width: 100%;') &&
      monochromeCss.includes('height: 100%;') &&
      monochromeCss.includes('max-width: none;') &&
      monochromeCss.includes('max-height: none;') &&
      monochromeCss.includes('border: 1px solid rgba(12, 204, 104, 0.3);'),
    'CRT sessions should open as a full-screen surface inside a restrained physical screen aperture'
  );
  assert(monochromeCss.includes('button:not(.workspace-history-item)'), 'CRT dialog button styling should not hide recent workspace paths');
  assert(indexHtml.includes('.key-hint') && indexHtml.includes('background: #00ff00'), 'CRT numeric keys should retain their original phosphor fill');
  assert(indexHtml.includes('text-shadow: 0 0 5px currentColor'), 'CRT interface should retain its original phosphor text glow');
  assert(!indexHtml.includes('inline-key-hint'), 'CRT numeric keys should not add redesigned badge chrome');
  assert(indexHtml.includes('.agent-block:hover') && indexHtml.includes('background: #3a3a3a'), 'CRT agent hover should match the sidebar background response');
  assert(!indexHtml.includes('text-shadow: 0 0 10px rgba(0, 255, 255, 0.5)'), 'CRT agent hover should not weaken the inherited phosphor glow');
  assert(indexHtml.includes('id="system-ip"') && indexHtml.includes('id="system-time"'), 'CRT top bar should expose system identity and time');
  assert(indexHtml.includes('>IP: <span id="system-ip"') && indexHtml.includes('>TIME: <span id="system-time"') && indexHtml.includes('>UPTIME: <span id="uptime"'), 'CRT system identity labels should remain uppercase');
  assert(indexHtml.includes('AGENTS:') && indexHtml.includes('TOK/MIN:') && indexHtml.includes('id="tokens-per-minute"'), 'CRT top bar should expose uppercase Agent count and token rate');
  for (const label of ['NEW AGENT', 'TASK LIST', 'HISTORY', 'SKILLS', 'BILLING', 'SETTINGS']) {
    assert(indexHtml.includes(`</span> ${label}`), `CRT sidebar label should be uppercase: ${label}`);
  }
  assert(crtApp.includes('data.usageRate') && crtApp.includes('formatCrtTokenRate'), 'CRT should render the server token-rate estimate');
  assert(server.includes('agentManager.getAgentUsageSnapshots()') && server.includes('estimatedTokensPerMinute: usageSnapshot.estimatedTokensPerMinute'), 'System stats should publish the aggregate token-rate estimate');
  assert(indexHtml.indexOf('id="system-ip"') < indexHtml.indexOf('id="system-time"') && indexHtml.indexOf('id="system-time"') < indexHtml.indexOf('id="uptime"'), 'CRT IP and time should sit immediately before uptime');
  assert(indexHtml.includes('id="dynamic-heat"'), 'CRT settings should expose the dynamic heat toggle');
  assert(crtApp.includes("globalSettings.crtDynamicHeatEnabled === true ? agent.activityLevel : ''"), 'CRT heat classes should be opt-in');
  assert(crtApp.includes('formatSystemClock'), 'CRT should format the server system clock');
  assert(crtApp.includes('candidate.previewCols === terminal.cols'), 'CRT should wait for a dimension-matched terminal snapshot');
  assert(!crtApp.includes("`${getCrtAgentTitle(agent)} (${agent.id})`"), 'CRT session titles should not expose internal Agent ids');
  assert(indexHtml.includes('.crt-checkbox:checked::before'), 'CRT settings should use terminal-style checkboxes');
  assert(indexHtml.includes('content: "[✓]"'), 'CRT checked state should use a retro check mark');
  assert(crtApp.includes('workspaceHistoryExpanded = getWorkspaceHistory().length > 0'), 'CRT New Agent should show recent workspaces immediately');
  assert(indexHtml.includes('.settings-panel') && indexHtml.includes('0 0 6px rgba(0, 255, 0, 0.2)'), 'CRT settings borders should retain restrained phosphor glow');
  assert(crtApp.includes('"JetBrains Mono", "SF Mono", Menlo'), 'CRT terminal fallback should preserve readable mixed-language metrics');
  assert(indexHtml.includes('.agent-block.working .agent-output'), 'CRT should blink only working agent previews');
  assert(!indexHtml.includes('.agent-block.hot .agent-output'), 'recent activity alone should not blink CRT previews');
  assert(crtApp.includes("outputTail.className = 'agent-output-tail'"), 'CRT cards should anchor live output at the bottom');
  assert(crtApp.includes("outputTail.textContent = cleanOutput || 'No output yet...'"), 'CRT cards should expose all available live preview text');
  assert(indexHtml.includes('.agent-output-tail') && indexHtml.includes('bottom: 0'), 'CRT live tails should fill cards without compressing text');
  assert(!crtApp.includes('calculateCrtPreviewFontSize'), 'CRT cards should not compress text to fit a full snapshot');
  assert(crtApp.includes('getCrtAgentTitle'), 'CRT cards and sessions should use meaningful agent titles');
  assert(crtApp.includes('getCrtProjectName(agent)'), 'CRT card status should show the project name instead of the full workspace path');

  console.log('✓ Frontend bridge files are present');
}

run();
