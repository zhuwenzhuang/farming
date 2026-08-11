// Generated from TypeScript. Do not edit.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isAgentStateWire = isAgentStateWire;
function record(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : null;
}
function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}
function providerCapabilitiesWire(value) {
    const capabilities = record(value);
    return Boolean(capabilities
        && Array.isArray(capabilities.supportedRuntimes)
        && capabilities.supportedRuntimes.every(runtime => runtime === 'terminal' || runtime === 'acp')
        && typeof capabilities.runtimeSwitch === 'boolean'
        && typeof capabilities.terminalProfile === 'boolean'
        && (capabilities.terminalComposerInput === 'plain-text' || capabilities.terminalComposerInput === 'bracketed-paste')
        && typeof capabilities.goals === 'boolean'
        && typeof capabilities.terminalSessionFork === 'boolean'
        && typeof capabilities.sessionFork === 'boolean'
        && (capabilities.chatRuntime === '' || capabilities.chatRuntime === 'acp')
        && typeof capabilities.supportsChat === 'boolean'
        && typeof capabilities.supportsSteer === 'boolean');
}
function runtimeBindingWire(value) {
    const binding = record(value);
    return Boolean(binding
        && (binding.kind === 'terminal'
            || (binding.kind === 'acp' && typeof binding.state === 'string')));
}
function runtimeObservationWire(value) {
    const observation = record(value);
    return Boolean(observation
        && ['codex', 'claude', 'shell', 'process', 'unknown'].includes(String(observation.kind || ''))
        && ['starting', 'working', 'waiting', 'idle', 'exited', 'unknown'].includes(String(observation.phase || ''))
        && ['authoritative', 'high', 'heuristic'].includes(String(observation.confidence || ''))
        && ['structured-runtime', 'shell-marker', 'terminal-observer'].includes(String(observation.source || ''))
        && typeof observation.observerVersion === 'string'
        && finiteNumber(observation.observedAt));
}
function isAgentStateWire(value) {
    const agent = record(value);
    return Boolean(agent
        && typeof agent.id === 'string'
        && agent.id.length > 0
        && typeof agent.command === 'string'
        && typeof agent.cwd === 'string'
        && typeof agent.output === 'string'
        && ['pending', 'running', 'stopped', 'dead'].includes(String(agent.status || ''))
        && typeof agent.isMain === 'boolean'
        && ['hot', 'warm', 'cool', 'cold'].includes(String(agent.activityLevel || ''))
        && finiteNumber(agent.lastActivity)
        && finiteNumber(agent.attentionScore)
        && typeof agent.isZombie === 'boolean'
        && providerCapabilitiesWire(agent.providerCapabilities)
        && runtimeBindingWire(agent.runtimeBinding)
        && runtimeObservationWire(agent.runtimeObservation));
}
