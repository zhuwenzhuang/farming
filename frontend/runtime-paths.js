(function attachRuntimePaths(global) {
  const pathname = String(global.location && global.location.pathname || '').replace(/\/+$/, '');
  const crtMarker = '/crt';
  const markerIndex = pathname.lastIndexOf(crtMarker);
  const basePath = markerIndex >= 0 ? pathname.slice(0, markerIndex) : '';

  function path(suffix = '/') {
    const normalizedSuffix = suffix.startsWith('/') ? suffix : `/${suffix}`;
    return basePath ? `${basePath}${normalizedSuffix}` : normalizedSuffix;
  }

  function apiPath(suffix = '/') {
    const normalizedSuffix = suffix.startsWith('/') ? suffix : `/${suffix}`;
    return path(`/api${normalizedSuffix}`);
  }

  function webSocketUrl() {
    const protocol = global.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${global.location.host}${path('/ws')}`;
  }

  global.FarmingRuntimePaths = {
    basePath,
    path,
    apiPath,
    webSocketUrl,
  };
})(window);
