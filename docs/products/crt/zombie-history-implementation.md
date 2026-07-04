# Zombie Cleanup And History Archive Notes

> Chinese version: [zombie-history-implementation.zh_cn.md](./zombie-history-implementation.zh_cn.md)

Last updated: 2026-05-01

## Scope

- automatic zombie cleanup for sub-agents;
- archive-on-kill history pipeline;
- Sidebar History (`H`) and archived run display;
- no separate Zombies sidebar item.

## Current Behavior

1. A zombie is a `running` non-Main Agent whose `lastActivity` is older than `AgentManager.ZOMBIE_IDLE_MS` (currently 72 hours).
2. Heartbeat runs a zombie sweep every 60 seconds.
3. Each manual kill or zombie cleanup creates a history entry in `settings.json` under `taskHistory`.
4. Natural process exit for non-Main Agents is archived as `process-exit`.
5. The frontend reads `state.taskHistory`; the Sidebar `H` menu opens the History dialog.

## Entry Fields

- `id`
- `agentId`
- `command`
- `cwd`
- `task`
- `source`
- `reason`
- `status`
- `startedAt`
- `lastActivity`
- `archivedAt`

`reason` is one of `manual-kill`, `zombie-cleanup`, or `process-exit`.

## Follow-Ups

- filter history by workspace or reason;
- history detail page;
- restart-from-history action;
- optional delayed confirmation before zombie cleanup.

## Verification

Recommended local checks:

```bash
npm run typecheck
npm run build
npm test
```

Run Playwright before release when UI behavior changes:

```bash
npm run test:e2e:playwright
```
