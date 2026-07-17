const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
}

function run() {
  const shareButtonSource = read('src/components/code/ShareQrButton.tsx');
  const mobileShareSource = read('src/components/code/MobileShareSheet.tsx');
  const sidebarSource = read('src/components/code/CodeSidebar.tsx');
  const copySource = read('src/components/code/copy.ts');
  const stylesSource = read('src/styles/main.css');
  const darkStylesSource = read('src/styles/code-dark.css');
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
  assert(shareButtonSource.includes('writeTerminalClipboardText(current.longUrl)'));
  assert(shareButtonSource.includes('ticket.shortUrl'), 'QR matrix should encode the short URL');
  assert(shareButtonSource.includes('className="code-share-qr-canvas"'));
  assert(shareButtonSource.includes("appPath('/farming-2/app-icon-v2-180.png')"), 'QR center should use the production-safe Farming icon');
  assert(shareButtonSource.includes('className="code-share-countdown"'));
  assert(!shareButtonSource.includes('ticket?.code ||'), 'short ticket codes should stay out of the visible QR popover');
  assert(shareButtonSource.includes('ticket?.tokenLabel'), 'visible copy label should prefer the poetic token');
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
  assert(sidebarSource.includes('shareTarget: WorkspaceShareTarget | null'));
  assert(sidebarSource.includes('<ShareQrButton copy={copy} sidebarCollapsed={sidebarCollapsed} shareTarget={shareTarget} />'));
  assert(copySource.includes('copyFullShareLink:'));
  assert(copySource.includes("copyFullShareLink: '复制完整链接'"));

  assert(stylesSource.includes('.code-share-popover'));
  assert(stylesSource.includes('width: 264px;'));
  assert(stylesSource.includes('.code-share-qr-frame'));
  assert(stylesSource.includes('.code-share-qr-canvas'));
  assert(stylesSource.includes('.code-share-countdown'));
  assert(!stylesSource.includes('.code-share-meta'));
  assert(stylesSource.includes('.code-share-copy-token'));
  assert(stylesSource.includes('.code-share-token'));
  assert(stylesSource.includes('.code-share-token.single-line'));
  assert(stylesSource.includes('.code-share-token-measure'));
  assert(stylesSource.includes('.code-share-token-line'));
  assert(stylesSource.includes('.code-sidebar.collapsed .code-share-root'));
  assert(darkStylesSource.includes('.code-share-popover'));
  assert(darkStylesSource.includes('.code-share-countdown'));
  assert(!darkStylesSource.includes('.code-share-meta'));
  assert(darkStylesSource.includes('.code-share-copy-token'));

  assert(!mobileShareSource.includes('MobileSharePlatform'));
  assert(!mobileShareSource.includes('navigator.userAgent'));
  assert(mobileShareSource.includes('writeTerminalClipboardText'));
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
  assert(darkStylesSource.includes('.code-mobile-install-control'));

  console.log('code share QR assertions passed');
}

run();
