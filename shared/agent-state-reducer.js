// Generated from TypeScript. Do not edit.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.advanceAgentStateSnapshot = advanceAgentStateSnapshot;
exports.agentStateDeltaDisposition = agentStateDeltaDisposition;
exports.applyAgentStateDelta = applyAgentStateDelta;
function advanceAgentStateSnapshot(cursor, generation, sequence, page, receivedAgentCount) {
    const nextOffset = page.offset + receivedAgentCount;
    const validPage = Boolean(page.id)
        && Number.isInteger(page.offset)
        && page.offset >= 0
        && Number.isInteger(page.total)
        && page.total >= 0
        && Number.isInteger(receivedAgentCount)
        && receivedAgentCount >= 0
        && nextOffset <= page.total
        && page.complete === (nextOffset === page.total);
    if (!validPage)
        return { cursor, disposition: 'resync' };
    if (page.offset === 0) {
        return {
            disposition: 'replace',
            cursor: page.complete ? null : {
                generation,
                sequence,
                id: page.id,
                nextOffset,
                total: page.total,
            },
        };
    }
    if (!cursor
        || cursor.generation !== generation
        || cursor.sequence !== sequence
        || cursor.id !== page.id
        || cursor.nextOffset !== page.offset
        || cursor.total !== page.total) {
        return { cursor, disposition: 'resync' };
    }
    return {
        disposition: 'append',
        cursor: page.complete ? null : { ...cursor, nextOffset },
    };
}
function agentStateDeltaDisposition(cursor, generation, sequence) {
    if (!cursor || cursor.generation !== generation)
        return 'resync';
    if (sequence <= cursor.sequence)
        return 'ignore';
    return sequence === cursor.sequence + 1 ? 'apply' : 'resync';
}
function applyAgentStateDelta(agents, upserts, removedAgentIds) {
    if (upserts.length === 0 && removedAgentIds.length === 0)
        return agents;
    const removals = new Set(removedAgentIds);
    const replacements = new Map(upserts.map(agent => [agent.id, agent]));
    const retainedIds = new Set();
    let changed = false;
    const nextAgents = [];
    for (const agent of agents) {
        if (removals.has(agent.id)) {
            changed = true;
            continue;
        }
        const replacement = replacements.get(agent.id);
        if (replacement) {
            nextAgents.push(replacement);
            retainedIds.add(agent.id);
            if (replacement !== agent)
                changed = true;
            continue;
        }
        nextAgents.push(agent);
        retainedIds.add(agent.id);
    }
    for (const agent of replacements.values()) {
        if (removals.has(agent.id) || retainedIds.has(agent.id))
            continue;
        nextAgents.push(agent);
        retainedIds.add(agent.id);
        changed = true;
    }
    return changed ? nextAgents : agents;
}
