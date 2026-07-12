const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
  const terminalBridgePath = path.join(__dirname, '../../frontend/terminal-bridge.js');
  const skinBridgePath = path.join(__dirname, '../../frontend/skin-bridge.js');
  const runtimePathsPath = path.join(__dirname, '../../frontend/runtime-paths.js');
  const indexHtmlPath = path.join(__dirname, '../../frontend/skins/crt/index.html');
  const effectsCssPath = path.join(__dirname, '../../frontend/skins/crt/styles/effects.css');
  const webglEffectsPath = path.join(__dirname, '../../frontend/skins/crt/effects/crt-webgl-effects.js');
  const monochromeCssPath = path.join(__dirname, '../../frontend/skins/crt/styles/monochrome-green.css');
  const departureFontPath = path.join(__dirname, '../../frontend/skins/crt/assets/fonts/departure-mono/DepartureMonoNerdFontMono-Regular.otf');
  const departureLicensePath = path.join(__dirname, '../../frontend/skins/crt/assets/fonts/departure-mono/LICENSE');
  const pkgConfigPath = path.join(__dirname, '../../pkg.config.cjs');
  const serverPath = path.join(__dirname, '../../backend/server.js');

  const terminalBridge = fs.readFileSync(terminalBridgePath, 'utf8');
  const skinBridge = fs.readFileSync(skinBridgePath, 'utf8');
  const runtimePaths = fs.readFileSync(runtimePathsPath, 'utf8');
  const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
  const effectsCss = fs.readFileSync(effectsCssPath, 'utf8');
  const webglEffects = fs.readFileSync(webglEffectsPath, 'utf8');
  const monochromeCss = fs.readFileSync(monochromeCssPath, 'utf8');
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
  assert(runtimePaths.includes("path('/ws')"), 'CRT runtime should connect to the base-path WebSocket');
  assert(
    indexHtml.indexOf('runtime-paths.js') < indexHtml.indexOf('terminal-bridge.js'),
    'CRT runtime paths should load before frontend bridges'
  );
  assert(indexHtml.includes('../vendor/xterm/xterm.js'), 'CRT should load the shared xterm browser runtime');
  assert(indexHtml.includes('../vendor/xterm/addon-fit.js'), 'CRT should load the xterm fit addon');
  assert(indexHtml.includes('../vendor/xterm/addon-webgl.js'), 'CRT should load the xterm WebGL addon');
  assert(indexHtml.includes('effects/crt-webgl-effects.js'), 'CRT should load its isolated WebGL effects engine');
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
    !effectsCss.includes('animation: scanlines'),
    'CRT scanlines should remain static to avoid compositor churn'
  );
  assert(indexHtml.includes('class="crt-scan-beam"'), 'CRT entry should render the lightweight scan beam');
  assert(indexHtml.includes('class="crt-phosphor-noise"'), 'CRT entry should render one shared procedural phosphor noise layer');
  assert(indexHtml.includes('class="crt-scan-afterglow"'), 'CRT entry should retain a brighter region behind the scan beam');
  assert(effectsCss.includes('animation: crt-scan-beam-cycle 6.7s'), 'CRT beam should follow the frequent lightweight reference cycle');
  assert(effectsCss.includes('animation: crt-scan-afterglow-cycle 6.7s'), 'CRT afterglow should stay synchronized with the scan beam');
  assert(effectsCss.includes('transform: scale3d(1, 1, 1)'), 'CRT afterglow should brighten the area already scanned');
  assert(effectsCss.includes('height: clamp(180px, 30vh, 320px)'), 'CRT scan should use a long reference-shaped phosphor trail');
  assert(effectsCss.includes('background: rgba(39, 225, 118, 0.026)'), 'CRT afterglow should stay perceptible without looking like an alert signal');
  assert(!effectsCss.includes('#farming-crt:not(.no-crt)::after'), 'CRT should not darken the viewport edges with a vignette');
  assert(effectsCss.includes('phosphor-noise.svg'), 'CRT scan trail should use an original static noise texture');
  assert(effectsCss.includes('crt-content-afterimage 620ms'), 'CRT content changes should leave a short phosphor afterimage');
  assert(crtApp.includes('appendCrtPreviewAfterimage'), 'CRT previews should use event-driven phosphor decay');
  assert(crtApp.includes('CRT_PREVIEW_RENDER_INTERVAL_MS = 1000'), 'CRT dashboard previews should batch to at most one visual update per second');
  assert(crtApp.includes('scheduleCrtPreviewCardRender') && crtApp.includes('dashboardRenderDeferred'), 'CRT should target changed cards and defer dashboard rendering behind an open terminal');
  assert(!crtApp.includes('drawImage('), 'CRT terminal output must not copy xterm canvases on the typing path');
  assert(!/(getImageData|toDataURL|drawImage|createImageBitmap)\s*\(/.test(webglEffects), 'CRT WebGL effects should avoid CPU screenshot APIs');
  assert(!crtApp.includes('pulseSessionTerminalPhosphor'), 'CRT terminal output must not animate the xterm screen on the typing path');
  assert(!effectsCss.includes('crt-phosphor-noise-shift'), 'CRT phosphor noise should remain static to avoid continuous full-screen compositing');
  assert(effectsCss.includes('#farming-crt.session-open .crt-scan-afterglow'), 'CRT should suspend moving scan layers while the user types in an opened terminal');
  assert(crtApp.includes("document.addEventListener('visibilitychange'") && crtApp.includes("window.addEventListener('pagehide'"), 'CRT should observe page visibility lifecycle events');
  assert(crtApp.includes('suspendCrtPageConnection') && crtApp.includes('wsReconnectTimer'), 'CRT should close hidden-page sockets and cancel reconnect work');
  assert(crtApp.includes('resumeCrtPageConnection') && crtApp.includes('refreshSessionView(true, activeAgentId'), 'CRT should reconnect and resync the focused terminal when visible again');
  assert(!effectsCss.includes('repeating-linear-gradient(\n            to right'), 'Monochrome Green should not use an RGB aperture mask');
  assert(indexHtml.includes('id="farming-crt"'), 'CRT effects should be scoped to the CRT skin root');
  assert(indexHtml.includes('styles/effects.css'), 'CRT entry should load its private effects stylesheet');
  assert(indexHtml.includes('styles/monochrome-green.css'), 'CRT entry should load its private Monochrome Green stylesheet');
  assert(fs.existsSync(departureFontPath), 'CRT should bundle the Departure Mono font');
  assert(fs.readFileSync(departureLicensePath, 'utf8').includes('SIL OPEN FONT LICENSE Version 1.1'), 'CRT should retain the Departure Mono license');
  assert(monochromeCss.includes('font-family: "Departure Mono CRT"'), 'CRT should use Departure Mono for its interface');
  assert(monochromeCss.includes('"PingFang SC"') && monochromeCss.includes('"Noto Sans Mono CJK SC"'), 'CRT should retain readable CJK font fallbacks');
  assert(crtApp.includes('FarmingTerminalBridge.DEFAULT_FONT_FAMILY'), 'CRT terminal output should use the shared mixed-language font stack');
  assert(
    crtApp.includes('DEFAULT_TERMINAL_FONT_SIZE = 12') &&
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
