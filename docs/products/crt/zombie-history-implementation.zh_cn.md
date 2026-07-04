# Zombie Cleanup & History Archive Notes

> English version: [zombie-history-implementation.md](./zombie-history-implementation.md)

Last updated: 2026-05-01

## Scope

- Automatic zombie cleanup (sub-agent only)
- Archive-on-kill history pipeline
- Sidebar **History (`H`)** 与归档展示；**不设独立 Zombies 侧栏项**（僵尸态在地图卡片 / 规则层呈现）

## Current behavior

1. Zombie判定仍为：`running` 且非 Main Agent 且 `lastActivity` 严格超过 `AgentManager.ZOMBIE_IDLE_MS`（当前 72 小时）。
2. Heartbeat 每 60 秒执行一次 zombie sweep；命中后自动触发 kill。
3. 每次 kill（manual 或 zombie cleanup）都会生成一条 history 记录并持久化到 `settings.json` 的 `taskHistory`。
4. 进程自然退出（非 Main Agent）也会归档为 `process-exit`。
5. 前端通过 `state.taskHistory` 获取历史记录，`Sidebar` 的 `H` 菜单可打开 History 对话框查看。

## Entry fields

- `id`, `agentId`, `command`, `cwd`, `task`, `source`
- `reason` (`manual-kill` | `zombie-cleanup` | `process-exit`)
- `status`, `startedAt`, `lastActivity`, `archivedAt`

## Follow-ups

- History 筛选（按 workspace / reason）
- History 详情页与“一键重拉起”
- Zombie 清理前可选延时确认策略

## Verification（本地）

最近一次完整校验：

- `npm run typecheck`
- `npm run build`
- `npm test`（`scripts/run-tests.js` 通过 `tsx` 执行各 `backend/tests/test-*.js`，以便测试中 `import()` 仓库内 `src/**/*.ts` 模块）

Playwright E2E 未在本次改动中强制重跑；发布前可按仓库惯例执行 `npm run test:e2e:playwright`。
