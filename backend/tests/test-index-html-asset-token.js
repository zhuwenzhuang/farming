const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  appendIndexHtmlAssetToken,
  rewriteIndexHtmlForBasePath,
} = require('../index-html');

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
    withToken.includes('/farming/farming-2/favicon-v2.ico?token='),
    'static product icons should carry the startup token'
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

  const productIndex = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'public/farming-2/site.webmanifest'), 'utf8'));
  const faviconHeader = fs.readFileSync(path.join(repoRoot, 'public/farming-2/favicon-v2.ico')).subarray(0, 4);
  assert(productIndex.includes('app-icon-v2-180.png'), 'iOS should use the versioned high-resolution touch icon');
  assert(productIndex.includes('favicon-v2-32.png'), 'browser tabs should use the versioned small-icon crop');
  assert(manifest.icons.some(icon => icon.src === 'app-icon-v2-maskable-512.png' && icon.purpose === 'maskable'), 'the PWA manifest should provide a mask-safe Android icon');
  assert.deepStrictEqual([...faviconHeader], [0, 0, 1, 0], 'the v2 favicon should be a binary ICO rather than base64 text');

  console.log('✓ Tokenized entry page assets for first-load mobile browsers');
}

run();
