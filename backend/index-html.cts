function normalizeBasePath(basePath: unknown): string {
  if (!basePath || basePath === '/') return '';
  const value = String(basePath);
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function routePath(basePath: unknown, suffix: unknown = ''): string {
  const normalizedBase = normalizeBasePath(basePath);
  const suffixValue = String(suffix);
  const normalizedSuffix = suffixValue.startsWith('/') ? suffixValue : `/${suffixValue}`;
  return normalizedBase ? `${normalizedBase}${normalizedSuffix}` : normalizedSuffix;
}

function rewriteIndexHtmlForBasePath(html: unknown, basePath: unknown): string {
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

function appendIndexHtmlAssetToken(html: unknown, token: unknown): string {
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

function applyIndexHtmlAppearance(html: unknown, appearance: unknown): string {
  const appearanceValue = typeof appearance === 'string' ? appearance : '';
  const normalizedAppearance = ['light', 'dark', 'paper'].includes(appearanceValue)
    ? appearanceValue
    : 'system';
  let source = String(html || '');
  if (/\bdata-appearance-preference="[^"]*"/i.test(source)) {
    source = source.replace(
      /\bdata-appearance-preference="[^"]*"/i,
      `data-appearance-preference="${normalizedAppearance}"`
    );
  } else {
    source = source.replace(
      /<html\b/i,
      `<html data-appearance-preference="${normalizedAppearance}"`
    );
  }

  const colorScheme = normalizedAppearance === 'system'
    ? 'light dark'
    : normalizedAppearance === 'paper' ? 'light' : normalizedAppearance;
  const themeColor = normalizedAppearance === 'dark'
    ? '#181818'
    : normalizedAppearance === 'paper' ? '#f7f4ed' : '#ffffff';
  return source
    .replace(
      /(<meta\s+name="color-scheme"\s+content=")[^"]*(")/i,
      `$1${colorScheme}$2`
    )
    .replace(
      /(<meta\s+name="theme-color"\s+content=")[^"]*(")/i,
      `$1${themeColor}$2`
    );
}

export {
  applyIndexHtmlAppearance,
  normalizeBasePath,
  routePath,
  rewriteIndexHtmlForBasePath,
  appendIndexHtmlAssetToken,
};
