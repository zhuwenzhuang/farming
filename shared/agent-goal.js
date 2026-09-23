// Generated from TypeScript. Do not edit.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeAgentGoal = normalizeAgentGoal;
function normalizeAgentGoal(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const raw = value;
    if (typeof raw.objective !== 'string' || !raw.objective.trim()
        || typeof raw.status !== 'string' || !raw.status.trim())
        return null;
    const goal = { objective: raw.objective.trim(), status: raw.status.trim() };
    for (const key of ['tokenBudget', 'tokensUsed', 'timeUsedSeconds']) {
        if (typeof raw[key] === 'number' && Number.isFinite(raw[key]) && raw[key] >= 0)
            goal[key] = raw[key];
    }
    return goal;
}
