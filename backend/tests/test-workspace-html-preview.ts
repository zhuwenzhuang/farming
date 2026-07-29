const assert = require('assert');

const {
  workspaceFileSupportsViewer,
  workspaceFileViewerContributions,
} = require('../../src/lib/workspace-viewer-registry.ts');
const {
  buildWorkspaceHtmlPreviewDocument,
  workspaceHtmlPreviewRefreshDelay,
} = require('../../src/lib/workspace-html-preview.ts');

assert.strictEqual(workspaceFileSupportsViewer('site/index.html', 'html.preview'), true);
assert.strictEqual(workspaceFileSupportsViewer('site/index.htm', 'html.preview'), true);
assert.strictEqual(workspaceFileSupportsViewer('site/INDEX.HTML', 'html.preview'), true);
assert.strictEqual(workspaceFileSupportsViewer('site/index.ts', 'html.preview'), false);
assert.deepStrictEqual(
  workspaceFileViewerContributions('README.md').map(viewer => viewer.id),
  ['markdown.preview'],
);

const baseUrl = 'https://farming.example/farming/api/files/previews/preview-1/base/';
const rootUrl = 'https://farming.example/farming/api/files/previews/preview-1/root/';
const document = buildWorkspaceHtmlPreviewDocument(
  '<!doctype html><html><head><title>Demo</title></head><body><img src="/assets/logo.png"><link rel="stylesheet" href="styles.css"><script>alert(1)</script></body></html>',
  baseUrl,
  rootUrl,
);

assert(document.includes(`base href="${baseUrl}"`));
assert(document.includes("script-src 'none'"));
assert(document.includes(`img src="${rootUrl}assets/logo.png"`));
assert(document.includes('href="styles.css"'));
assert(document.indexOf('<base') < document.indexOf('<title>'));

const fragmentDocument = buildWorkspaceHtmlPreviewDocument(
  [
    '<main>',
    '<a href="/docs/start.html">Docs</a>',
    '<img SRC=\'/images/logo.svg\'>',
    '<video poster="/media/poster.png"></video>',
    '<div style="background:url( /images/background.png )"></div>',
    '<img src="//cdn.example/logo.png">',
    '</main>',
  ].join(''),
  baseUrl,
  rootUrl,
);
assert(fragmentDocument.startsWith('<head>'));
assert(fragmentDocument.includes(`href="${rootUrl}docs/start.html"`));
assert(fragmentDocument.includes(`SRC='${rootUrl}images/logo.svg'`));
assert(fragmentDocument.includes(`poster="${rootUrl}media/poster.png"`));
assert(fragmentDocument.includes(`url( ${rootUrl}images/background.png )`));
assert(fragmentDocument.includes('src="//cdn.example/logo.png"'));

const headlessHtmlDocument = buildWorkspaceHtmlPreviewDocument(
  '<html lang="zh"><body>你好 &amp; Farming</body></html>',
  baseUrl,
  rootUrl,
);
assert(headlessHtmlDocument.includes(`<html lang="zh"><head>`));
assert(headlessHtmlDocument.includes('你好 &amp; Farming'));

const escapedUrlDocument = buildWorkspaceHtmlPreviewDocument(
  '<img src="/logo.svg">',
  'https://farming.example/base/?a=1&b=2',
  'https://farming.example/root/?a=1&b=2/',
);
assert(escapedUrlDocument.includes('a=1&amp;b=2'));
assert(!escapedUrlDocument.includes('a=1&b=2'));
assert.strictEqual(workspaceHtmlPreviewRefreshDelay(200_000, 100_000), 40_000);
assert.strictEqual(workspaceHtmlPreviewRefreshDelay(100_500, 100_000), 1_000);

console.log('workspace HTML preview assertions passed');
