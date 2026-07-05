const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
}

function run() {
  const shareButtonSource = read('src/components/code/ShareQrButton.tsx');
  const sidebarSource = read('src/components/code/CodeSidebar.tsx');
  const copySource = read('src/components/code/copy.ts');
  const stylesSource = read('src/styles/main.css');
  const darkStylesSource = read('src/styles/code-dark.css');
  const packageSource = read('package.json');

  assert(packageSource.includes('"qrcode-generator"'), 'QR rendering should use the mature qrcode-generator matrix library');
  assert(shareButtonSource.includes("import qrcode from 'qrcode-generator'"));
  assert(shareButtonSource.includes('HOVER_DWELL_MS = 250'), 'hover should dwell before creating a share ticket');
  assert(shareButtonSource.includes("fetch(appPath('/api/share/qr-ticket')"));
  assert(shareButtonSource.includes("method: 'DELETE'"));
  assert(shareButtonSource.includes('writeTerminalClipboardText(current.longUrl)'));
  assert(shareButtonSource.includes('ticket.shortUrl'), 'QR matrix should encode the short URL');
  assert(shareButtonSource.includes('className="code-share-qr-canvas"'));
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
  assert(shareButtonSource.includes("appPath('/farming-2/images/avatar-watercolor-v1-bee-garden.png')"));
  assert(shareButtonSource.includes('<FarmingQrCode value={ticket.shortUrl} badgeUrl={badgeUrl} />'));

  assert(sidebarSource.includes("import { ShareQrButton } from './ShareQrButton'"));
  assert(sidebarSource.includes('<ShareQrButton copy={copy} sidebarCollapsed={sidebarCollapsed} />'));
  assert(copySource.includes('copyFullShareLink:'));
  assert(copySource.includes("copyFullShareLink: '复制完整链接'"));

  assert(stylesSource.includes('.code-share-popover'));
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

  console.log('code share QR assertions passed');
}

run();
