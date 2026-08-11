const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readCodeStyleSource, readCodeStyles } = require('./style-source-reader');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
}

function run() {
  const shareButtonSource = read('src/components/code/ShareQrButton.tsx');
  const mobileShareSource = read('src/components/code/MobileShareSheet.tsx');
  const sidebarSource = read('src/components/code/CodeSidebar.tsx');
  const workspaceSource = read('src/components/CodeWorkspace.tsx');
  const transcriptSource = read('src/components/code/AgentTranscriptPane.tsx');
  const fileActionsSource = read('src/components/files/FileEditorActions.tsx');
  const directShareSource = read('src/lib/qr-share-ticket.ts');
  const copySource = read('src/components/code/copy.ts');
  const appSource = read('src/App.tsx');
  const webSocketSource = read('src/hooks/useWebSocket.ts');
  const stylesSource = readCodeStyles();
  const shareStylesSource = readCodeStyleSource('src/styles/share.css');
  const appearanceTokensSource = readCodeStyleSource('src/styles/tokens.css');
  const mainStylesSource = readCodeStyleSource('src/styles/main.css');
  const packageSource = read('package.json');

  assert(packageSource.includes('"qrcode-generator"'), 'QR rendering should use the mature qrcode-generator matrix library');
  assert(shareButtonSource.includes("import type qrcode from 'qrcode-generator'"));
  assert(shareButtonSource.includes("workspaceShareTargetWithCurrentReadingAnchor"));
  assert(shareButtonSource.includes("type WorkspaceShareTarget"));
  assert(shareButtonSource.includes('shareTarget?: WorkspaceShareTarget | null'));
  assert(shareButtonSource.includes('const shareTargetSignature = workspaceShareTargetKey(shareTarget)'));
  assert(shareButtonSource.includes('function preloadQrCodeFactory'));
  assert(shareButtonSource.includes("import('qrcode-generator')"), 'hover should preload the QR renderer without creating a share ticket');
  assert(shareButtonSource.includes('onMouseEnter={preloadQrRenderer}'));
  assert(!shareButtonSource.includes('scheduleHoverOpen'), 'hover should not open the QR popover or create a share ticket');
  assert(shareButtonSource.includes('if (!open || pinned) return'), 'only an open, unpinned popover should schedule hover close');
  assert(shareButtonSource.includes('POPOVER_WIDTH = 264'), 'share popover placement should match the compact larger QR width');
  assert(shareButtonSource.includes("fetch(appPath('/api/share/qr-ticket')"));
  assert(shareButtonSource.includes('const target = workspaceShareTargetWithCurrentReadingAnchor(shareTarget)'));
  assert(shareButtonSource.includes('JSON.stringify(target ? { target } : {})'));
  assert(shareButtonSource.includes("method: 'DELETE'"));
  assert(shareButtonSource.includes('writeClipboardText(nextTicket.longUrl)'));
  assert(shareButtonSource.includes('writeClipboardText(fullAccessUrl)'));
  assert(shareButtonSource.includes('void createAndCopyTicket(force)'));
  assert(shareButtonSource.includes('ticket.shortUrl'), 'QR matrix should encode the short URL');
  assert(shareButtonSource.includes('className="code-share-qr-canvas"'));
  assert(shareButtonSource.includes("appPath('/farming-2/app-icon-v2-180.png')"), 'QR center should use the production-safe Farming icon');
  assert(shareButtonSource.includes('className="code-share-countdown"'));
  assert(!shareButtonSource.includes('ticket?.code ||'), 'short ticket codes should stay out of the visible QR popover');
  assert(shareButtonSource.includes('ticket?.tokenLabel'), 'the writable passphrase should remain visible');
  assert(shareButtonSource.includes('ticket.fullAccessUrl'), 'the owner passphrase button should require a writable URL');
  assert(shareButtonSource.includes("ticket.shortUrlAccessMode === 'owner'"), 'QR messaging should follow the issued permission');
  assert(shareButtonSource.includes('copy.shareQrFullAccessWarning'));
  assert(shareButtonSource.includes('copy.shareQrReadOnlyWarning'));
  assert(
    shareButtonSource.includes('ticket?.tokenLabel && ticket.fullAccessUrl && ('),
    'read-only re-shares must hide the owner passphrase and writable URL button'
  );
  assert(!shareButtonSource.includes('code-share-passphrase-warning'));
  assert(shareButtonSource.includes('function tokenDisplayLines'));
  assert(shareButtonSource.includes(".split('-')"));
  assert(shareButtonSource.includes('singleLineTokenFits'));
  assert(shareButtonSource.includes('new ResizeObserver(updateTokenFit)'));
  assert(shareButtonSource.includes('className="code-share-token-line"'));
  assert(shareButtonSource.includes('className="code-share-token-measure"'));
  assert(shareButtonSource.includes('closeSharePopoverOnOutsidePointerDown'));
  assert(shareButtonSource.includes("document.addEventListener('pointerdown', closeSharePopoverOnOutsidePointerDown, true)"));
  assert(shareButtonSource.includes('rootRef.current?.contains(target)'));
  assert(shareButtonSource.includes('<FarmingQrCode value={ticket.shortUrl} badgeUrl={badgeUrl} qrCodeFactory={qrCodeFactory} />'));

  assert(sidebarSource.includes("import { ShareQrButton } from './ShareQrButton'"));
  assert(shareButtonSource.includes("import { CheckGlyph, ShareGlyph } from '@/components/IconGlyphs'"));
  assert(shareButtonSource.includes('<ShareGlyph className="code-share-icon" />'));
  assert(sidebarSource.includes('shareTarget: WorkspaceShareTarget | null'));
  assert(
    sidebarSource.includes('<ShareQrButton') &&
      sidebarSource.includes('shareTarget={shareTarget}') &&
      sidebarSource.includes("emptyHomeActionRequest?.kind === 'share'"),
    'the empty-workspace Share action should reuse the sidebar QR control'
  );
  assert(shareButtonSource.includes('openRequest = 0'));
  assert(shareButtonSource.includes('handledOpenRequestRef.current === openRequest'));
  assert(shareButtonSource.includes('openPopover(true, true)'));
  assert(copySource.includes("sharePage: '分享当前页面'"));
  assert(!copySource.includes("shareTokenLabel: '俳句口令'"));
  assert(!copySource.includes("shareShortLinkLabel: '分享短链'"));
  assert(copySource.includes("copiedShareLink: '当前页面只读链接已复制'"));
  assert(copySource.includes("shareLinkVisibility: '只能查看，不能修改；链接会随倒计时过期。'"));
  assert(copySource.includes("copyFullAccessShareLink: '复制完整控制口令链接'"));
  assert(copySource.includes("copiedFullAccessShareLink: '完整控制口令链接已复制'"));
  assert(!copySource.includes('sharePassphraseFullAccessWarning'));
  assert(copySource.includes("shareQrFullAccessWarning: '二维码包含完整控制口令链接。'"));
  assert(copySource.includes("shareQrReadOnlyWarning: '二维码包含当前页面的只读链接。'"));
  assert(copySource.includes("copyReadOnlyShareLink: '复制只读分享链接'"));
  assert(copySource.includes("copiedReadOnlyShareLink: '只读分享链接已复制；只能查看，链接会自动过期'"));

  assert(transcriptSource.includes('data-testid="code-agent-transcript-share-answer"'));
  assert(transcriptSource.includes("locator: { kind: 'message', id: turnId }"));
  assert(transcriptSource.includes("onCopyReadOnlyShareLink({ kind: 'agent', agentId, readingAnchor })"));
  assert(fileActionsSource.includes('data-testid="code-file-editor-share"'));
  assert(fileActionsSource.includes('copy.copyReadOnlyShareLink'));
  assert(workspaceSource.includes('const directShareRequestFenceRef = useRef(new LatestRequestFence())'));
  assert(workspaceSource.includes('requestReadOnlyShareLink(target, copy.shareLinkFailed)'));
  assert(workspaceSource.includes('if (!lease.isCurrent()) return'));
  assert(workspaceSource.includes('writeClipboardText(shareLink.url)'));
  assert(workspaceSource.includes('copy.copiedReadOnlyShareLink'));
  assert(workspaceSource.includes('shareLink?.revokeUnusedTicket()'));
  assert(directShareSource.includes("record?.longUrlAccessMode !== 'read-only'"));
  assert(directShareSource.includes("method: 'DELETE'"));

  assert(stylesSource.includes('.code-share-popover'));
  assert(stylesSource.includes('width: 264px;'));
  assert(stylesSource.includes('.code-share-qr-frame'));
  assert(stylesSource.includes('.code-share-qr-canvas'));
  assert(stylesSource.includes('.code-share-countdown'));
  assert(stylesSource.includes('.code-share-qr-access-note'));
  assert(appSource.includes('data-testid="code-read-only-share-banner"'));
  assert(appSource.includes('只读分享 · 只能查看，不能修改'));
  assert(webSocketSource.includes("const accessMode = msg.accessMode === 'read-only' ? 'read-only' : 'owner'"));
  assert(!stylesSource.includes('.code-share-meta'));
  assert(shareButtonSource.includes('data-testid="code-share-copy-link"'), 'the poetic passphrase should copy the writable URL');
  assert(shareButtonSource.includes('className="code-share-token-card-main"'));
  assert(shareButtonSource.includes('className="code-share-copy-action"'));
  assert(shareButtonSource.includes('data-testid="code-share-copy-status"'));
  assert(!shareButtonSource.includes('data-testid="code-share-copied-toast"'));
  assert(
    shareButtonSource.indexOf('className="code-share-qr-frame"') <
      shareButtonSource.indexOf('data-testid="code-share-copy-status"') &&
      shareButtonSource.indexOf('data-testid="code-share-copy-status"') <
        shareButtonSource.indexOf('data-testid="code-share-copy-link"'),
    'read-only copy confirmation should sit between the QR code and the full-control copy button'
  );
  assert(stylesSource.includes('.code-share-token-card'));
  assert(stylesSource.includes('.code-share-copy-status'));
  assert(stylesSource.includes('.code-share-token'));
  assert(stylesSource.includes('.code-share-token.single-line'));
  assert(stylesSource.includes('.code-share-token-measure'));
  assert(stylesSource.includes('.code-share-token-line'));
  assert(stylesSource.includes('.code-sidebar.collapsed .code-share-root'));
  assert(shareStylesSource.includes('.code-share-popover'));
  assert(shareStylesSource.includes('.code-share-countdown'));
  assert(!shareStylesSource.includes('.code-share-meta'));
  assert(shareStylesSource.includes('.code-share-token-card'));
  assert(shareStylesSource.includes('.code-share-copy-status'));
  assert(appearanceTokensSource.includes('--code-share-'));
  assert(!shareStylesSource.includes('data-appearance'));
  assert(!mainStylesSource.includes('.code-share-popover'));

  assert(!mobileShareSource.includes('MobileSharePlatform'));
  assert(!mobileShareSource.includes('navigator.userAgent'));
  assert(mobileShareSource.includes('writeClipboardText'));
  assert(!mobileShareSource.includes('code-mobile-share-system-action'));
  assert(mobileShareSource.includes('code-mobile-share-copy-action'));
  assert(mobileShareSource.includes('copy.mobileForwardTitle'));
  assert(mobileShareSource.includes('copy.mobileInstallChromeHint'));
  assert(mobileShareSource.includes('copy.mobileInstallShareStep'));
  assert(mobileShareSource.includes('copy.mobileInstallMoreStep'));
  assert(mobileShareSource.includes('copy.mobileInstallAddStep'));
  assert(copySource.includes("mobileShareTitle: '分享页面'"));
  assert(copySource.includes("mobileForwardTitle: '转发当前页面'"));
  assert(copySource.includes("mobileShareCopyAction: '复制链接'"));
  assert(copySource.includes("mobileInstallChromeHint: '确认已使用系统浏览器或 Chrome 打开当前页面。'"));
  assert(copySource.includes("mobileInstallAddStep: '选择“添加到主屏幕”。'"));
  assert(stylesSource.includes('.code-mobile-install-steps'));
  assert(stylesSource.includes('.code-mobile-install-control'));
  assert(stylesSource.includes('.code-mobile-install-more'));
  assert(stylesSource.includes('.code-mobile-share-link-row'));
  assert(shareStylesSource.includes('.code-mobile-install-control'));

  console.log('code share QR assertions passed');
}

run();
