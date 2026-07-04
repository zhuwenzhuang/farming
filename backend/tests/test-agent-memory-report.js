const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  buildMemoryReport,
  collectMemoryEvents,
  formatMemoryReport,
  resolveReportRange,
} = require('../agent-memory-report');

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJsonl(file, records) {
  fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function run() {
  const tmpRoot = fs.mkdtempSync(path.join(process.cwd(), '.tmp-farming-memory-report-'));
  const homeDir = path.join(tmpRoot, 'home', 'admin');
  const repo = path.join(homeDir, 'repo');
  const otherRepo = path.join(homeDir, 'other-repo');
  mkdirp(repo);
  mkdirp(otherRepo);

  const now = new Date(2026, 3, 12, 23, 30, 0);
  const today = '2026-04-12T10:00:00.000Z';
  const yesterday = '2026-04-11T09:00:00.000Z';
  const old = '2026-04-08T09:00:00.000Z';

  const claudeDir = path.join(homeDir, '.claude', 'projects', '-home-admin-repo');
  mkdirp(claudeDir);
  const claudeFile = path.join(claudeDir, 'session.jsonl');
  writeJsonl(claudeFile, [
    {
      type: 'user',
      timestamp: today,
      cwd: repo,
      message: { role: 'user', content: [{ type: 'text', text: '修复登录模块的异常处理' }] },
    },
    {
      type: 'assistant',
      timestamp: today,
      cwd: repo,
      message: { role: 'assistant', content: [{ type: 'text', text: '已经补充登录模块测试' }] },
    },
    {
      type: 'user',
      timestamp: old,
      cwd: repo,
      message: { role: 'user', content: '这条不应该进入今日报告' },
    },
  ]);
  fs.utimesSync(claudeFile, now, now);

  const codexDir = path.join(homeDir, '.codex', 'sessions', '2026', '04', '12');
  mkdirp(codexDir);
  const codexFile = path.join(codexDir, 'rollout.jsonl');
  writeJsonl(codexFile, [
    {
      type: 'session_meta',
      timestamp: today,
      payload: { cwd: otherRepo },
    },
    {
      type: 'response_item',
      timestamp: today,
      item: {
        role: 'assistant',
        content: [{ type: 'output_text', text: '发现 optimizer 里有空指针风险' }],
      },
      payload: { cwd: otherRepo },
    },
  ]);
  fs.utimesSync(codexFile, now, now);

  const qwenDir = path.join(homeDir, '.qwen', 'tmp', 'run-1');
  mkdirp(qwenDir);
  const qwenFile = path.join(qwenDir, 'logs.json');
  writeJson(qwenFile, {
    logs: [
      {
        role: 'user',
        createdAt: yesterday,
        workspace: repo,
        content: '昨天整理了 workspace 候选逻辑',
      },
    ],
  });
  fs.utimesSync(qwenFile, now, now);

  const todayEvents = collectMemoryEvents({ homeDir, period: 'today', now }).events;
  assert.strictEqual(todayEvents.length, 4);
  assert(todayEvents.some(event => event.agent === 'claude' && event.text.includes('登录模块')));
  assert(todayEvents.some(event => event.agent === 'codex' && event.workspace === otherRepo));
  assert(!todayEvents.some(event => event.text.includes('昨天整理')));
  assert(!todayEvents.some(event => event.text.includes('不应该进入今日')));

  const yesterdayReport = buildMemoryReport({ homeDir, period: 'yesterday', now });
  assert.strictEqual(yesterdayReport.stats.events, 1);
  assert.strictEqual(yesterdayReport.agents[0].name, 'qwen');
  assert(formatMemoryReport(yesterdayReport).includes('Farming 昨日记忆报告'));

  const weekReport = buildMemoryReport({ homeDir, period: 'week', now });
  assert.strictEqual(weekReport.stats.events, 6);
  assert.strictEqual(weekReport.stats.agents, 3);
  assert(weekReport.workspaces.some(workspace => workspace.path === repo));
  assert(weekReport.workspaces.some(workspace => workspace.path === otherRepo));

  const customRange = resolveReportRange({
    period: 'today',
    since: '2026-04-11',
    until: '2026-04-13',
    now,
  });
  assert.strictEqual(customRange.label, '自定义');
  assert.strictEqual(customRange.start.getFullYear(), 2026);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('test-agent-memory-report passed');
}

run();
