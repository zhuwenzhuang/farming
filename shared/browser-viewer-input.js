// Generated from TypeScript. Do not edit.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isBrowserViewerInputMessage = isBrowserViewerInputMessage;
function isBrowserViewerInputMessage(value) {
    if (!value || typeof value !== 'object')
        return false;
    const input = value;
    const finite = (key, optional = false) => (optional && input[key] === undefined)
        || (typeof input[key] === 'number' && Number.isFinite(input[key]) && Math.abs(input[key]) <= 1_000_000);
    if (input.modifiers !== undefined && (!Number.isInteger(input.modifiers) || Number(input.modifiers) < 0 || Number(input.modifiers) > 15))
        return false;
    switch (input.type) {
        case 'key':
            return typeof input.key === 'string' && input.key.length > 0 && input.key.length <= 64
                && (input.code === undefined || (typeof input.code === 'string' && input.code.length <= 64))
                && (input.action === undefined || input.action === 'down' || input.action === 'up')
                && (input.text === undefined || (typeof input.text === 'string' && input.text.length <= 64))
                && (input.repeat === undefined || typeof input.repeat === 'boolean')
                && (input.location === undefined || (typeof input.location === 'number' && [0, 1, 2, 3].includes(input.location)));
        case 'text': return typeof input.text === 'string' && input.text.length <= 1_000_000;
        case 'pointer':
            return ['move', 'down', 'up'].includes(String(input.action)) && finite('x') && finite('y')
                && (input.button === undefined || ['left', 'middle', 'right'].includes(String(input.button)))
                && (input.buttons === undefined || (Number.isInteger(input.buttons) && Number(input.buttons) >= 0 && Number(input.buttons) <= 7))
                && (input.clickCount === undefined || (typeof input.clickCount === 'number' && [0, 1, 2, 3].includes(input.clickCount)));
        case 'wheel': return finite('x', true) && finite('y', true) && finite('deltaX') && finite('deltaY');
        case 'reset-input': return true;
        case 'clipboard': return ['read', 'cut'].includes(String(input.operation))
            && typeof input.requestId === 'string' && /^[\w-]{1,80}$/.test(input.requestId)
            && (input.operation !== 'cut' || (typeof input.token === 'string' && /^[\w-]{1,80}$/.test(input.token)));
        default: return false;
    }
}
