function normalizeBasePath(basePath) {
  if (!basePath || basePath === '/') return '';
  return basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
}

function routePath(basePath, suffix = '') {
  const normalizedBase = normalizeBasePath(basePath);
  const normalizedSuffix = suffix.startsWith('/') ? suffix : `/${suffix}`;
  return normalizedBase ? `${normalizedBase}${normalizedSuffix}` : normalizedSuffix;
}

function rewriteIndexHtmlForBasePath(html, basePath) {
  const normalizedBase = normalizeBasePath(basePath);
  const runtimeBaseScript = `<script>window.__FARMING_BASE_PATH__=${JSON.stringify(normalizedBase || '')}</script>`;
  const withRuntimeBase = String(html || '').includes('window.__FARMING_BASE_PATH__')
    ? String(html || '')
    : String(html || '').replace('</head>', `    ${runtimeBaseScript}\n  </head>`);
  if (!normalizedBase) return withRuntimeBase;
  const escapedBase = normalizedBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return withRuntimeBase
    .replace(/(src|href)="\/assets\//g, `$1="${normalizedBase}/assets/`)
    .replace(/(src|href)="\/farming-2\//g, `$1="${normalizedBase}/farming-2/`)
    .replace(new RegExp(`(src|href)="${escapedBase}${escapedBase}/`, 'g'), `$1="${normalizedBase}/`);
}

function appendIndexHtmlAssetToken(html, token) {
  const assetToken = String(token || '');
  if (!assetToken) return String(html || '');
  const encodedToken = encodeURIComponent(assetToken);

  return String(html || '').replace(/\b(src|href)="([^"]+)"/g, (match, attr, url) => {
    if (!url || /(?:[?&])token=/.test(url)) return match;
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')) return match;
    if (!/(?:^|\/)assets\//.test(url)) return match;

    const hashIndex = url.indexOf('#');
    const urlWithoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
    const hash = hashIndex >= 0 ? url.slice(hashIndex) : '';
    const separator = urlWithoutHash.includes('?') ? '&' : '?';
    return `${attr}="${urlWithoutHash}${separator}token=${encodedToken}${hash}"`;
  });
}

module.exports = {
  normalizeBasePath,
  routePath,
  rewriteIndexHtmlForBasePath,
  appendIndexHtmlAssetToken,
};
