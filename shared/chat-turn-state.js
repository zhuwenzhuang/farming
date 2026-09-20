// Generated from TypeScript. Do not edit.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isChatTurnState = isChatTurnState;
exports.interruptChatTurn = interruptChatTurn;
function isChatTurnState(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const turn = value;
    return typeof turn.turnId === 'string' && turn.turnId.length > 0
        && typeof turn.status === 'string'
        && ['active', 'cancelling', 'completed', 'cancelled', 'failed', 'interrupted'].includes(turn.status)
        && typeof turn.message === 'string'
        && typeof turn.updatedAt === 'number' && Number.isFinite(turn.updatedAt);
}
/** Only proven loss of a running binding interrupts a turn, not transport loss. */
function interruptChatTurn(value, message) {
    if (!isChatTurnState(value))
        return null;
    if (value.status === 'cancelling') {
        return { ...value, status: 'cancelled', message: '', updatedAt: Date.now() };
    }
    if (value.status !== 'active')
        return value;
    return { ...value, status: 'interrupted', message, updatedAt: Date.now() };
}
