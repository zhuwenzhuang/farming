const assert = require('assert');
const fs = require('fs');
const path = require('path');
const appearanceThemes = require('../../shared/appearance-themes.json');
const {
  appendWebAppManifestToken,
  applyIndexHtmlAppearance,
  appendIndexHtmlAssetToken,
  rewriteIndexHtmlForBasePath,
} = require('../index-html.cjs');

function assertAssetCarriesStartupToken(html, assetPath, startupToken) {
  const escapedAssetPath = assetPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp(`(?:src|href)="([^"]*${escapedAssetPath}[^"]*)"`));
  assert(match, `Missing rewritten asset URL for ${assetPath}`);
  const values = [...new URL(match[1], 'https://farming.example').searchParams.values()];
  assert(values.includes(startupToken), `${assetPath} should carry the startup token`);
}

function run() {
  const repoRoot = path.join(__dirname, '..', '..');
  const html = [
    '<!doctype html>',
    '<html>',
    '<head>',
    '<script type="module" src="/assets/index.js"></script>',
    '<link rel="modulepreload" href="/assets/chunk.js">',
    '<link rel="stylesheet" href="/farming/assets/index.css">',
    '<link rel="manifest" href="/farming-2/site.webmanifest">',
    '<link rel="icon" href="/farming-2/favicon-v2.ico">',
    '<link rel="preconnect" href="https://example.invalid/assets/remote.js">',
    '</head>',
    '</html>',
  ].join('\n');

  const startupToken = '测试令牌-山月-晨光';
  const rewritten = rewriteIndexHtmlForBasePath(html, '/farming');
  const withToken = appendIndexHtmlAssetToken(rewritten, startupToken);

  assertAssetCarriesStartupToken(withToken, '/farming/assets/index.js', startupToken);
  assertAssetCarriesStartupToken(withToken, '/farming/assets/chunk.js', startupToken);
  assertAssetCarriesStartupToken(withToken, '/farming/assets/index.css', startupToken);
  assertAssetCarriesStartupToken(withToken, '/farming/farming-2/site.webmanifest', startupToken);
  assert(
    withToken.includes('<link rel="icon" href="/farming/farming-2/favicon-v2.ico">'),
    'public product icons should keep a stable token-free URL for installed web apps'
  );
  assert(
    withToken.includes('https://example.invalid/assets/remote.js'),
    'external asset-like URLs should not be rewritten'
  );

  const once = appendIndexHtmlAssetToken('<script src="/farming/assets/index.js?existing=old"></script>', 'new');
  assertAssetCarriesStartupToken(once, '/farming/assets/index.js', 'new');
  assert.strictEqual(
    appendIndexHtmlAssetToken(once, 'other'),
    once,
    'asset token rewriting should remain idempotent after attaching its generated query parameter'
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
  const paperEntry = applyIndexHtmlAppearance(
    '<html data-appearance-preference="system"><head><meta name="color-scheme" content="light dark"><meta name="theme-color" content="#ffffff"></head>',
    'paper'
  );
  assert(
    paperEntry.includes('data-appearance-preference="paper"'),
    'the entry document should receive the saved Paper appearance before its first paint'
  );
  assert(
    paperEntry.includes('<meta name="color-scheme" content="light">'),
    'Paper should keep native browser controls in their light color scheme'
  );
  assert(
    paperEntry.includes(`<meta name="theme-color" content="${appearanceThemes.paper.metadata.themeColor}">`),
    'the browser chrome should receive the Paper metadata color from the shared appearance registry'
  );
  assert(
    applyIndexHtmlAppearance('<html>', 'unexpected')
      .includes('data-appearance-preference="system"'),
    'invalid saved appearances should retain the system-color fallback'
  );

  const productIndex = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
  const mainSource = fs.readFileSync(path.join(repoRoot, 'src/main.tsx'), 'utf8');
  const serverSource = fs.readFileSync(path.join(repoRoot, 'backend/server.cts'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'public/farming-2/site.webmanifest'), 'utf8'));
  const personalizedManifest = appendWebAppManifestToken(manifest, startupToken);
  const faviconHeader = fs.readFileSync(path.join(repoRoot, 'public/farming-2/favicon-v2.ico')).subarray(0, 4);
  assert(productIndex.includes('app-icon-v2-180.png'), 'iOS should use the versioned high-resolution touch icon');
  assert(productIndex.includes('favicon-v2-32.png'), 'browser tabs should use the versioned small-icon crop');
  assert(productIndex.includes('data-appearance-preference="system"'), 'the entry document should expose a server-rewritable appearance preference');
  assert(
    productIndex.includes(`background: ${appearanceThemes.paper.css['--code-bg-canvas']};`)
      && productIndex.includes(`"themeColor":"${appearanceThemes.paper.metadata.themeColor}"`),
    'the Paper first-paint bootstrap should agree with the shared appearance registry',
  );
  assert(productIndex.includes("root.dataset.appearance = appearance"), 'the entry document should resolve its first-paint appearance before loading app code');
  assert(
    mainSource.includes('rememberStartupAccessToken(window.location.href)')
      && !mainSource.includes("searchParams.delete('token')"),
    'the loaded application should retain the credential-bearing owner URL for reload and installed-app handoff',
  );
  assert.strictEqual(manifest.id, undefined, 'the installed app identity should inherit the resolved start URL instead of collapsing custom base paths to one origin-level id');
  assert.strictEqual(manifest.start_url, '../', 'the public manifest fallback should keep a token-free start URL');
  assert.strictEqual(
    personalizedManifest.start_url,
    `../?token=${encodeURIComponent(startupToken)}`,
    'an authenticated install should reopen the base path with its explicit owner token',
  );
  assert.strictEqual(
    appendWebAppManifestToken({ start_url: '../?mode=compact&token=old#workspace' }, startupToken).start_url,
    `../?mode=compact&token=${encodeURIComponent(startupToken)}#workspace`,
    'manifest personalization should replace an old token while preserving other startup state',
  );
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
  assert(
    serverSource.indexOf("app.get(routePath(BASE_PATH, '/farming-2/site.webmanifest')")
      < serverSource.indexOf("app.use(routePath(BASE_PATH, '/farming-2'), express.static(publicProductAssetsDir"),
    'the personalized installed-app manifest should take precedence over public product assets',
  );
  assert(serverSource.includes("'/apple-touch-icon.png'"), 'iOS should have a conventional root touch-icon route');
  assert(serverSource.includes("routePath(BASE_PATH, '/apple-touch-icon.png')"), 'iOS should have a base-path touch-icon route');

  console.log('✓ Entry assets keep app code authenticated and installed-app icons publicly fetchable');
}

run();
