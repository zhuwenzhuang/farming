// Generated from TypeScript. Do not edit.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeAgentHandoffContext = normalizeAgentHandoffContext;
const provider_session_identity_js_1 = require("./provider-session-identity.js");
function normalizeAgentHandoffContext(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const context = value;
    if (context.version !== 1 || typeof context.sourceSessionKey !== 'string'
        || context.sourceSessionKey.length > 2048 || !(0, provider_session_identity_js_1.decodeProviderSessionKey)(context.sourceSessionKey))
        return null;
    return { version: 1, sourceSessionKey: context.sourceSessionKey };
}
