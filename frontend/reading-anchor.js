// Generated from TypeScript. Do not edit.
"use strict";
// A skin-neutral, per-tab reading-location protocol. Renderers own how they
// resolve an anchor; this module owns only its stable shape and transport-safe
// storage. Never put terminal text in an anchor: terminal locations use a
// short fingerprint of adjacent logical lines instead.
(function installFarmingReadingAnchors(global) {
    'use strict';
    const VERSION = 1;
    const STORAGE_PREFIX = 'farming.reading-anchor.v1:';
    const SURFACES = new Set(['chat', 'terminal', 'file']);
    const LIMITS = { id: 512, path: 2048, workspace: 2048, encoded: 1800 };
    function isRecord(value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    }
    function boundedString(value, limit) {
        const text = typeof value === 'string' ? value.trim() : '';
        return text && text.length <= limit && !text.includes('\0') ? text : '';
    }
    function finiteNumber(value) {
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    }
    function normalizeAnchor(value) {
        if (!isRecord(value) || Number(value.version) !== VERSION)
            return null;
        const surface = boundedString(value.surface, 16);
        const resource = isRecord(value.resource) ? value.resource : null;
        const locator = isRecord(value.locator) ? value.locator : null;
        const position = isRecord(value.position) ? value.position : null;
        if (!SURFACES.has(surface) || !resource || !locator || !position)
            return null;
        if (surface === 'file') {
            const workspace = boundedString(resource.workspace, LIMITS.workspace);
            const path = boundedString(resource.path, LIMITS.path);
            const line = finiteNumber(position.value);
            const column = finiteNumber(position.column);
            if (resource.kind !== 'file'
                || locator.kind !== 'file-line'
                || !workspace
                || !path
                || !Number.isInteger(line)
                || (line ?? 0) < 1)
                return null;
            return {
                version: VERSION,
                surface,
                resource: { kind: 'file', workspace, path },
                locator: { kind: 'file-line', id: path },
                position: {
                    unit: 'line-column',
                    value: line,
                    ...(Number.isInteger(column) && (column ?? 0) >= 1 ? { column: column } : {}),
                },
            };
        }
        const agentId = boundedString(resource.id, LIMITS.id);
        const locatorId = boundedString(locator.id, LIMITS.id);
        if (resource.kind !== 'agent' || !agentId || !locatorId)
            return null;
        if (surface === 'chat') {
            const fraction = finiteNumber(position.value);
            const childId = boundedString(locator.childId, LIMITS.id);
            if (locator.kind !== 'message'
                || position.unit !== 'fraction'
                || fraction === null
                || fraction < 0
                || fraction > 1)
                return null;
            return {
                version: VERSION,
                surface,
                resource: { kind: 'agent', id: agentId },
                locator: { kind: 'message', id: locatorId, ...(childId ? { childId } : {}) },
                position: { unit: 'fraction', value: fraction },
            };
        }
        const rowOffset = finiteNumber(position.value);
        const lineCount = finiteNumber(locator.lineCount);
        if (surface !== 'terminal'
            || locator.kind !== 'terminal-lines'
            || position.unit !== 'row'
            || !Number.isInteger(rowOffset)
            || (rowOffset ?? -1) < 0)
            return null;
        return {
            version: VERSION,
            surface,
            resource: { kind: 'agent', id: agentId },
            locator: {
                kind: 'terminal-lines',
                id: locatorId,
                ...(Number.isInteger(lineCount) && (lineCount ?? 0) > 0 ? { lineCount: lineCount } : {}),
            },
            position: { unit: 'row', value: rowOffset },
        };
    }
    function keyFor(anchor) {
        const normalized = normalizeAnchor(anchor);
        if (!normalized)
            return '';
        if (normalized.resource.kind === 'file') {
            return `file:${normalized.resource.workspace}:${normalized.resource.path}`;
        }
        return `agent:${normalized.resource.id}:${normalized.surface}`;
    }
    function storageKey(key) {
        return `${STORAGE_PREFIX}${key}`;
    }
    function save(anchor) {
        const normalized = normalizeAnchor(anchor);
        const key = normalized && keyFor(normalized);
        if (!normalized || !key)
            return null;
        try {
            global.sessionStorage.setItem(storageKey(key), JSON.stringify(normalized));
        }
        catch {
            // Private browsing or an exhausted browser store must not break viewing.
        }
        return normalized;
    }
    function read(key) {
        if (!key)
            return null;
        try {
            const parsed = JSON.parse(global.sessionStorage.getItem(storageKey(key)) || 'null');
            const normalized = normalizeAnchor(parsed);
            if (!normalized || keyFor(normalized) !== key) {
                if (parsed)
                    global.sessionStorage.removeItem(storageKey(key));
                return null;
            }
            return normalized;
        }
        catch {
            return null;
        }
    }
    function remove(key) {
        if (!key)
            return;
        try {
            global.sessionStorage.removeItem(storageKey(key));
        }
        catch {
            // Best-effort only.
        }
    }
    function agentKey(agentId, surface) {
        return `agent:${String(agentId || '').trim()}:${String(surface)}`;
    }
    function fileKey(workspace, path) {
        return `file:${String(workspace || '').trim()}:${String(path || '').trim()}`;
    }
    function fingerprint(parts) {
        const value = (Array.isArray(parts) ? parts : [parts])
            .map(part => String(part || '').slice(0, 2048))
            .join('\u001f');
        let hash = 0x811c9dc5;
        for (let index = 0; index < value.length; index += 1) {
            hash ^= value.charCodeAt(index);
            hash = Math.imul(hash, 0x01000193);
        }
        return `fnv1a-${(hash >>> 0).toString(36)}-${value.length.toString(36)}`;
    }
    function encode(anchor) {
        const normalized = normalizeAnchor(anchor);
        if (!normalized)
            return '';
        try {
            const text = JSON.stringify(normalized);
            const encoded = global.btoa(unescape(encodeURIComponent(text)))
                .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
            return encoded.length <= LIMITS.encoded ? encoded : '';
        }
        catch {
            return '';
        }
    }
    function decode(encoded) {
        const compact = boundedString(encoded, LIMITS.encoded);
        if (!compact || !/^[A-Za-z0-9_-]+$/.test(compact))
            return null;
        try {
            const padded = compact.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((compact.length + 3) % 4);
            return normalizeAnchor(JSON.parse(decodeURIComponent(escape(global.atob(padded)))));
        }
        catch {
            return null;
        }
    }
    function importEncoded(encoded) {
        const anchor = decode(encoded);
        return anchor ? save(anchor) : null;
    }
    function importFromSearch(search) {
        const params = new URLSearchParams(search || global.location.search || '');
        return importEncoded(params.get('fra') || '');
    }
    const anchorWindow = global;
    anchorWindow.FarmingReadingAnchors = {
        VERSION,
        agentKey,
        fileKey,
        save,
        read,
        remove,
        fingerprint,
        encode,
        decode,
        importEncoded,
        importFromSearch,
    };
}(window));
