// Generated from TypeScript. Do not edit.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeAcpPeerMessage = normalizeAcpPeerMessage;
function normalizeAcpPeerMessage(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const source = value;
    const bounded = (key, limit = 512) => typeof source[key] === 'string'
        && source[key].length > 0 && source[key].length <= limit ? source[key] : undefined;
    const senderAddress = bounded('senderAddress');
    if (source.version !== 1 || source.direction !== 'incoming' || !senderAddress)
        return null;
    return {
        version: 1, direction: 'incoming', senderAddress,
        ...(bounded('senderSessionId') ? { senderSessionId: bounded('senderSessionId') } : {}),
        ...(bounded('senderTaskId') ? { senderTaskId: bounded('senderTaskId') } : {}),
        ...(bounded('senderName', 240) ? { senderName: bounded('senderName', 240) } : {}),
        ...(bounded('timestamp', 80) ? { timestamp: bounded('timestamp', 80) } : {}),
        ...(source.bodyUnavailable === 'encrypted' ? { bodyUnavailable: 'encrypted' } : {}),
    };
}
