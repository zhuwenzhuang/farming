// Generated from TypeScript. Do not edit.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROJECT_ATTENTION_SCORE_MAX = void 0;
exports.projectWorkspaceFromAgentState = projectWorkspaceFromAgentState;
exports.agentTurnActiveFromState = agentTurnActiveFromState;
exports.PROJECT_ATTENTION_SCORE_MAX = 100;
function agentStateLike(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function projectWorkspaceFromAgentState(value) {
    if (!agentStateLike(value))
        return '';
    const gitWorktree = agentStateLike(value.gitWorktree) ? value.gitWorktree : null;
    return String(gitWorktree?.workspace || value.projectWorkspace || value.cwd || '');
}
function agentTurnActiveFromState(value) {
    if (!agentStateLike(value))
        return false;
    const observation = agentStateLike(value.runtimeObservation) ? value.runtimeObservation : null;
    const binding = agentStateLike(value.runtimeBinding) ? value.runtimeBinding : null;
    const phase = String(observation?.phase || '');
    return phase === 'working'
        || phase === 'waiting'
        || (phase === 'starting' && binding?.kind === 'terminal');
}
