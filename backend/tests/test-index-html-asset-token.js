const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  applyIndexHtmlAppearance,
  appendIndexHtmlAssetToken,
  rewriteIndexHtmlForBasePath,
} = require('../index-html.cjs');

function run() {
  const repoRoot = path.join(__dirname, '..', '..');
  const html = [
    '<!doctype html>',
    '<html>',
    '<head>',
    '<script type="module" src="/assets/index.js"></script>',
    '<link rel="modulepreload" href="/assets/chunk.js">',
    '<link rel="stylesheet" href="/farming/assets/index.css">',
    '<link rel="icon" href="/farming-2/favicon-v2.ico">',
    '<link rel="preconnect" href="https://example.invalid/assets/remote.js">',
    '</head>',
    '</html>',
  ].join('\n');

  const startupToken = '测试令牌-山月-晨光';
  const encodedToken = encodeURIComponent(startupToken);
  const rewritten = rewriteIndexHtmlForBasePath(html, '/farming');
  const withToken = appendIndexHtmlAssetToken(rewritten, startupToken);

  assert(
    withToken.includes(`/farming/assets/index.js?token=${encodedToken}`),
    'entry script should carry the startup token when the entry page was opened with a token'
  );
  assert(
    withToken.includes('/farming/assets/chunk.js?token='),
    'modulepreload assets should carry the startup token'
  );
  assert(
    withToken.includes('/farming/assets/index.css?token='),
    'stylesheet assets should carry the startup token'
  );
  assert(
    withToken.includes('<link rel="icon" href="/farming/farming-2/favicon-v2.ico">'),
    'public product icons should keep a stable token-free URL for installed web apps'
  );
  assert(
    withToken.includes('https://example.invalid/assets/remote.js'),
    'external asset-like URLs should not be rewritten'
  );

  const once = appendIndexHtmlAssetToken('<script src="/farming/assets/index.js?token=old"></script>', 'new');
  assert.strictEqual(
    once,
    '<script src="/farming/assets/index.js?token=old"></script>',
    'asset token rewriting should not duplicate an existing token query parameter'
  );

  const darkEntry = applyIndexHtmlAppearance(
    '<html data-appearance-preference="system"><head><meta name="color-scheme" content="light dark"><meta name="theme-color" content="#ffffff"></head>',
    'dark'
  );
  assert(
    darkEntry.includes('data-appearance-preference="dark"'),
    'the entry document should receive the saved dark appearance before its first paint'
  );
  assert(
    darkEntry.includes('<meta name="color-scheme" content="dark">'),
    'the browser should create a dark document canvas before parsing application styles'
  );
  assert(
    darkEntry.includes('<meta name="theme-color" content="#181818">'),
    'the browser chrome should receive the saved dark color with the entry document'
  );
  assert(
    applyIndexHtmlAppearance('<html>', 'unexpected')
      .includes('data-appearance-preference="system"'),
    'invalid saved appearances should retain the system-color fallback'
  );

  const productIndex = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
  const serverSource = fs.readFileSync(path.join(repoRoot, 'backend/server.cts'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'public/farming-2/site.webmanifest'), 'utf8'));
  const faviconHeader = fs.readFileSync(path.join(repoRoot, 'public/farming-2/favicon-v2.ico')).subarray(0, 4);
  assert(productIndex.includes('app-icon-v2-180.png'), 'iOS should use the versioned high-resolution touch icon');
  assert(productIndex.includes('favicon-v2-32.png'), 'browser tabs should use the versioned small-icon crop');
  assert(productIndex.includes('data-appearance-preference="system"'), 'the entry document should expose a server-rewritable appearance preference');
  assert(productIndex.includes("root.dataset.appearance = appearance"), 'the entry document should resolve its first-paint appearance before loading app code');
  assert.strictEqual(manifest.id, undefined, 'the installed app identity should inherit the resolved start URL instead of collapsing custom base paths to one origin-level id');
  assert.strictEqual(manifest.start_url, '../', 'the installed app should reopen the authenticated base path without persisting a token URL');
  assert.strictEqual(manifest.scope, '../', 'the installed app should keep Code and CRT routes inside the same standalone window');
  assert.strictEqual(manifest.display, 'standalone', 'the installed desktop app should omit ordinary browser tabs and address controls');
  const customBaseManifestUrl = new URL('https://farming.example/custom/base/farming-2/site.webmanifest');
  assert.strictEqual(new URL(manifest.start_url, customBaseManifestUrl).pathname, '/custom/base/', 'the installed app start URL should honor a custom Farming base path');
  assert.strictEqual(new URL(manifest.scope, customBaseManifestUrl).pathname, '/custom/base/', 'the installed app scope should honor a custom Farming base path');
  assert(manifest.icons.some(icon => icon.src === 'app-icon-v2-maskable-512.png' && icon.purpose === 'maskable'), 'the PWA manifest should provide a mask-safe Android icon');
  assert.deepStrictEqual([...faviconHeader], [0, 0, 1, 0], 'the v2 favicon should be a binary ICO rather than base64 text');
  assert(
    serverSource.indexOf("app.use(routePath(BASE_PATH, '/farming-2'), express.static(publicProductAssetsDir")
      < serverSource.indexOf('app.use(tokenAuth.middleware())'),
    'public product assets should be mounted before token authentication for OS icon fetchers'
  );
  assert(serverSource.includes("'/apple-touch-icon.png'"), 'iOS should have a conventional root touch-icon route');
  assert(serverSource.includes("routePath(BASE_PATH, '/apple-touch-icon.png')"), 'iOS should have a base-path touch-icon route');

  console.log('✓ Entry assets keep app code authenticated and installed-app icons publicly fetchable');
}

run();
