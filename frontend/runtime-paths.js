// Generated from TypeScript. Do not edit.
"use strict";
(function attachRuntimePaths(global) {
    const pathname = String(global.location?.pathname || '').replace(/\/+$/, '');
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
        return `${protocol}//${global.location.host}${navigationPath('/ws')}`;
    }
    function navigationPath(suffix = '/') {
        const url = new URL(path(suffix), global.location.href);
        const token = new URLSearchParams(global.location.search).get('token');
        if (token)
            url.searchParams.set('token', token);
        return `${url.pathname}${url.search}${url.hash}`;
    }
    global.FarmingRuntimePaths = {
        basePath,
        path,
        navigationPath,
        apiPath,
        webSocketUrl,
    };
})(window);
