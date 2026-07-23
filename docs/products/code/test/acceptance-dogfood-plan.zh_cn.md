# Farming 2 验收 Dogfood 测试方案

> English version: [acceptance-dogfood-plan.md](./acceptance-dogfood-plan.md)

本文档定义 Farming 2 的验收测试划分。目标不是只跑一组固定断言，而是让多个“资深用户型 Agent”并行使用隔离的 Farming 实例，从功能组件、真实用户场景、使用时长和使用强度几个维度持续发现问题。

常规自动化仍然默认使用 fake Codex / fake Claude，以保证高频回归稳定、低成本。验收 dogfood 必须支持真实 Codex / Claude Code，并尽早、低强度地暴露真实 CLI、真实登录态、真实 session history 和真实终端行为中的问题。

## 验收目标

Farming 2 的验收结论必须回答四个问题：

1. 用户能否从桌面或手机浏览器进入远端现场，并稳定监督多个 agent。
2. Codex / Claude Code 的启动、输入、resume、历史、usage、文件和 terminal 能力是否按真实行为工作。
3. 长时间运行、弱网、后端重启、agent 退出、归档和恢复路径是否概念清晰且可恢复。
4. UI 是否减少上下文切换，而不是制造新的焦虑、迷路或误操作。

## 执行层级

| 层级 | 默认频率 | Agent 来源 | 目标 |
| --- | --- | --- | --- |
| Static / unit | 每次提交 | 无真实 agent | 验证后端 helper、状态归一化、配置读写、静态接线 |
| Playwright fake e2e | 每次较大 UI 改动 | fake Codex / fake Claude / real bash | 验证可重复浏览器路径，不消耗真实额度 |
| Agent dogfood fake | 每日或每次大改 | 多个测试 Agent + fake coding agent | 深度探索 UI、状态和边界问题 |
| Real Codex / Claude smoke | 每日或合并前 | Linux 上的真实 Codex / Claude Code | 尽早验证真实 CLI、真实配置、真实 session resume |
| Real long soak | 手动或夜间 | Linux 上的少量真实 agent | 验证长时间运行、断线恢复、usage、手机回访 |

真实 Codex / Claude 测试必须显式开启，且默认限制 prompt 长度、任务数量和运行时长。不得触发 quota reset、危险配置重置或大规模真实任务。

## Linux 优先测试环境

Farming 2 的真实验收主战场是 Linux 开发机或 Linux 容器。macOS 本机可以用于写文档、跑 fake e2e、做 CLI 参数探测，但不作为真实发布体验的主要结论来源。

推荐 dogfood 目标按能力分层：

| 目标 | 连接方式 | 定位 | 必测内容 |
| --- | --- | --- | --- |
| Primary Linux | `ssh user@primary-linux` | primary real-agent Linux；已有 Node、Codex、Claude | 真实 Codex / Claude smoke、远端 `/farming`、手机访问、usage、archive/history |
| Claude-ready Linux | `ssh user@claude-linux` | 已有 Node 和 Claude | Claude Code smoke、Claude settings / slash / usage、远端访问 |
| Compatibility Linux | `ssh user@compat-linux` | bare / compatibility Linux；环境更老更薄 | CLI release、packaged runtime、native PTY 缺失时 fail fast、无 Codex/Claude 降级 |
| Linux container | 本机或远端容器 | 干净可重复环境 | 安装、端口、base path、token、无历史状态冷启动 |

Linux 目标每轮都要记录：

- `hostname`、`uname -srm`
- `node --version`、`npm --version`
- `command -v codex` / `codex --version`
- `command -v claude` / `claude --version`
- Farming 启动方式、端口、base path、token 状态

真实 agent smoke 优先在 primary Linux 跑；如果 Codex 不可用但 Claude 可用，则在 Claude-ready Linux 跑 Claude-only smoke；如果二者都不可用，仍需在 compatibility Linux 上验证页面能明确展示 agent unavailable，而不是静默失败。

## 隔离要求

每个 dogfood Agent 必须运行在隔离实例中：

- 独立 `HOME`，避免污染真实 `~/.farming`、Codex / Claude 历史和 shell 配置。
- 独立 `FARMING_CONFIG_DIR`、workspace、端口、server log 和浏览器 context。
- 独立 artifact 目录，保存截图、trace、console、server log、agent transcript 和最终报告。
- fake 层默认设置 `FARMING_E2E_FAKE_EXECUTABLES=1`。
- real 层不伪造 `FARMING_CODEX_BIN` / `claude`，但必须先记录可执行文件路径、版本和配置摘要。
- 远程 Linux 上每个 story 使用单独端口，避免多个 dogfood agent 互相抢同一个 Farming server。
- 真实 Codex / Claude smoke 可以复用目标机器现有登录态，但不能修改登录配置、默认模型配置或 quota/reset 相关状态。

推荐目录：

```text
.tmp/dogfood/runs/<run-id>/
├── <story-id>/
│   ├── home/
│   ├── workspace/
│   ├── server.log
│   ├── browser-trace.zip
│   ├── screenshots/
│   ├── agent-transcript.md
│   └── report.json
└── summary.md
```

## 功能组件划分

### 1. 启动和连接

覆盖：
- 首屏、token、WebSocket、后端心跳提示。
- Main Agent / New Agent 启动。
- workspace 默认值、最近 workspace、非法 workspace。
- 远端 `/farming` base path、端口占用和重启。

验收不变量：
- 后端未连接时页面必须明确提示。
- agent list 加载慢时不应出现不可点击的误导状态。
- 非法 workspace 不得进入历史。
- 手机和桌面能打开同一个远端实例。

### 2. Agent 启动配置

覆盖：
- Codex / Claude / bash / zsh 可执行发现。
- Codex model / reasoning / speed。
- Claude settings 摘要、模型、effort、启动 permission mode。
- agent launch profile 合并和手写 CLI 参数优先级；运行中切换权限会用所选 flag 重启，已有稳定 provider Session ID 时 resume、没有时启动新会话，并在替换过程中保持当前 agent 与 Chat / Terminal 视图。

验收不变量：
- UI 只展示真实可用或配置推导出的选项。
- Claude 配置不得泄露 token、base URL 或完整 env。
- Codex / Claude 切换不应展示做不到的统一能力。

### 3. Composer 和输入框

覆盖：
- 普通文本、Enter、Shift+Enter、Ctrl/Cmd+Enter。
- busy agent follow-up 队列和 steer。
- slash command、Skill mention、Claude workspace skill。
- 附件、粘贴图片、语音按钮、plan / goal 模式。
- 快捷键默认关闭，不能抢普通输入。
- 不能只测底部 composer。真实 agent smoke 必须同时聚焦嵌入式 terminal 本身，直接在 CLI prompt 里输入和回车；Qoder / Claude Code / OpenCode 的重度用户经常这样工作。
- terminal 直输必须覆盖 ASCII、中文等非 ASCII committed text、IME composition、中文和 ASCII 混输、粘贴 / committed text，以及普通 ASCII 不会被 IME fallback 重复发送。

验收不变量：
- 输入框聚焦时任何字母都不能被全局快捷键吞掉。
- slash menu 只展示当前 agent/provider 支持的能力。
- 附件路径不能以内联 base64 塞进 prompt。

### 4. Terminal 和 session 输出

覆盖：
- native node-pty / packaged node-pty；PTY 不可用时必须明确失败，不做降低体验的 fallback。
- terminal canvas 渲染、URL 点击、`path:line` 点击。
- 滚动到旧输出时，新输出不强拉到底。
- jump-to-latest、terminal focus、复制工作目录。
- 多 terminal 打开、切换、关闭和 agent 退出。
- 排查 terminal 中文 / IME 问题时，优先参考 xterm.js / VS Code 原则：让浏览器 composition 事件在 xterm helper textarea 中完整结束，只把最终 committed text 送入 PTY；不要另造一条并行输入法路径，也不要只用 synthetic paste 代替真实 CLI 截图验证。

验收不变量：
- terminal 非空、可交互、可持续追加输出。
- 用户在读旧输出时视口稳定。
- shell prompt、颜色和软换行不会破坏 hit-test。

### 5. Project / Sidebar / History

覆盖：
- Project 分组、Files section、active agent、active session；Files 展开后，变更、未跟踪、历史和根级文件树行应保持一致的字号、行高、垂直节奏，以及箭头和文字起点，计数和 Review 操作可保留语义强调。
- Pin / unread / rename / Move to History。
- Move Project to History。
- History 统一展示为 History Agents，按解析到的 agent/session 元数据更新时间排序；不在主页面 membership 中的 session 才出现在 History。
- duplicate title 下的 resume id / run id 区分。

验收不变量：
- `Move to History` 表示把对象移出主页面并进入 History；Farming 不再把 archive 当成额外特殊状态。
- Codex / Claude provider session 只有两种位置：主页面 membership 中，或 History 中。
- `Continue` 对真实 resume id 走 provider resume；无 resume id 时打开 New Agent 并预填 workspace / command。

### 6. Files / Editor

覆盖：
- Files 展开、目录懒加载、搜索、`path:line` 跳转。
- 文本、图片、二进制、大文件预览。
- 编辑、保存、外部变更、dirty 状态。
- git blame、Aone 链接、右键菜单。

验收不变量：
- Main Agent 不展示 Files，具体 Project agent 展示 Files。
- 文件操作被 workspace root 约束。
- 大文件和二进制文件不进入危险保存链路。

### 7. Usage 和系统状态

覆盖：
- Codex / Claude quota 摘要。
- 最近 24 小时的整点桶和时间轴、最近 52 周逐日且最近 7 天有明确区分的紧凑 token 热力图、缩写后的 token 总量，以及每个格子悬停时显示的精确 token 数。
- 点击两张紧凑图后分别打开对应的大热力图；52 周详情默认展示今天，并在右上角醒目显示今天缩写后的 token 数，悬停或用键盘聚焦其他日期时临时切换醒目值，同时下方保留精确数值；离开临时选择后必须回到今天。下方图表必须懒加载并切换为该日从零开始的 24 小时直方图，每个小时柱以精确的 provider session 归因为基础、按 Agent 类型聚合；快速经过不同日期时要取消过期请求。52 周 Token King 日的整个热力格裁成皇冠轮廓，其他超过 10 亿 token 的日期整格裁成火焰轮廓，沿用各格已有热力颜色，不能在方格内部嵌入小图标。详情分析继续使用同一份本地 token 数据，展示峰值时段、最近 7 天对比前 7 天，以及逐日明细可用时的缓存占比。
- tok/min、CPU、MEM、折叠和展开。
- 读取失败、无数据、真实 agent 高输出。

验收不变量：
- usage 默认折叠，折叠行仍显示关键速率和机器状态。
- Codex / Claude 首次 cc-statistics 扫描会生成 SQLite usage 缓存；未变化刷新不得读取 JSONL 正文，Session 追加后只能读取已保存偏移之后的字节，服务重启后继续复用同一缓存。用包含超长非 usage tool 输出行的真实日志验证 token-only 适配层保持内存有界，并确认冷/热缓存下的总量、小时和 Session 归因完全一致。在 macOS 与 Linux 都验证 Python 3.10+ 路径；运行时缺失时必须明确显示 usage 不可用，不得回退第二套解析器。
- 不执行 reset。
- 没有可用 token 遥测的 Provider 整块不展示；没有真实 quota 数据时不展示 unavailable 占位行。

### 8. 移动端和远程访问

覆盖：
- 手机首屏、左侧默认收起、top bar、more menu。
- 手机 History / Search / New Agent / terminal / Files。
- 键盘弹出时 composer 和 terminal 不被遮挡。
- 手机刷新后继续观察远端 agent。

验收不变量：
- 手机默认不挤压主内容。
- 点击 terminal 输出不应误弹键盘。
- 输入框聚焦时内容和发送按钮可见。

## 资深用户人设划分

| 人设 | 主要目标 | 深测路径 |
| --- | --- | --- |
| Remote Operator | 把 Farming 当远端工作台 | 远端启动、桌面/手机切换、后端重启、断线恢复 |
| Codex Power User | 深度使用真实 Codex | model/reasoning、slash skill、resume、真实输出、usage |
| Claude Power User | 深度使用真实 Claude Code | settings 摘要、permission/model/effort、workspace skill、resume |
| History Archivist | 管理大量会话和主页面 membership | duplicate title、Move to History、Move Project to History、主页面/History 切换、Continue |
| Terminal Heavy User | 长时间看输出和介入 | 大量输出、旧输出阅读、URL/path 点击、focus、复制 cwd |
| Files Editor User | 不离开 Farming 做轻量编辑 | 搜索、打开、编辑、保存、blame、外部变更 |
| Mobile Supervisor | 手机碎片化监督 | 收起侧栏、键盘、History、terminal、Files、刷新 |
| Failure Hunter | 专门破坏恢复路径 | 后端断开、agent exit、CLI 不存在、workspace 不存在、quota 读取失败 |

每个人设都要输出“资深用户评价”，包括哪些地方让人迷惑、哪些地方容易误点、哪些地方像真实工具而不是 demo。

## 使用时长和强度划分

| 强度 | 时长 | 用途 | 真实 agent 策略 |
| --- | --- | --- | --- |
| Micro smoke | 1-3 分钟 | 每次改动后的真实 CLI 快速检查 | 允许真实 Codex / Claude，各发 1 条极短 prompt |
| Focused story | 5-15 分钟 | 单一模块或单一人设深测 | fake 默认，real 可选 |
| Work session | 30-60 分钟 | 接近真实开发节奏 | 真实 agent 最多 1-2 个，限制任务 |
| Soak | 2-8 小时 | 长时间输出、手机回访、断线恢复 | 默认 fake；真实只在夜间手动开启 |

真实 prompt 示例应保持极小：

```text
请只回复一行：Farming real smoke OK
```

或在隔离临时 workspace 内执行一个极小文件修改：

```text
在 smoke.txt 末尾追加一行 farming-smoke-ok，然后停止。
```

## 首批并行验收任务

第一批建议同时启动 6 个 Agent：

1. `component-launch-history`：启动、New Agent、History、Move to History、Move Project to History。
2. `component-composer-terminal`：composer、slash、附件、terminal scroll、URL/path 点击。
3. `component-files-editor`：Files / Editor / blame / 外部变更。
4. `persona-mobile-supervisor`：手机端完整路径和键盘体验。
5. `real-codex-smoke-linux`：在 primary Linux 上验证真实 Codex 启动、极短 prompt、resume/history、usage 摘要。
6. `real-claude-smoke-linux`：优先在 primary Linux，必要时在 Claude-ready Linux 上验证真实 Claude Code 启动、极短 prompt、settings/model/effort、slash command。
7. `linux-compat-smoke`：在 compatibility Linux 或 Linux container 中验证 CLI release、无 agent 可用时的 UI 降级，以及 native PTY 不可用时的明确失败提示。

前 4 个默认使用 fake coding agents，可以高覆盖。后 3 个是 Linux-first 验收，必须显式标记目标机器、真实 agent 状态、版本、命令路径和消耗风险。

## 报告格式

每个测试 Agent 输出一个 `report.json`：

```json
{
  "storyId": "real-codex-smoke",
  "persona": "Codex Power User",
  "agentMode": "real-codex",
  "status": "pass",
  "coverage": ["start", "send prompt", "history", "usage"],
  "findings": [
    {
      "severity": "P2",
      "title": "没有 token 遥测的 Provider 仍被展示",
      "steps": ["Start real Codex", "Send one-line prompt", "Open usage row"],
      "expected": "省略该 Provider 和 unavailable quota 占位",
      "actual": "仍展示了 unavailable 和零值行",
      "evidence": ["screenshots/usage.png", "server.log"]
    }
  ],
  "artifacts": ["browser-trace.zip", "agent-transcript.md"],
  "notes": "Subjective UX notes from a senior user"
}
```

汇总器生成 `summary.md`，按 P0/P1/P2/P3 排序，并标出：

- 是否真实 Codex / Claude 才复现。
- 是否 fake e2e 已覆盖。
- 是否需要新增稳定自动化测试。
- 是否只是体验改进建议。

## 通过标准

一次验收轮通过需要满足：

- P0 / P1 为 0。
- 真实 Codex smoke 和真实 Claude smoke 至少能完成启动或给出明确、可行动的失败原因。
- 手机端核心路径无阻塞：打开、选择 agent、查看输出、输入、History。
- Archive / History 概念无双态错觉：归档后不再表现为 live agent，继续运行路径明确。
- 所有 P2 以上问题都有截图、trace 或日志证据。

## 当前可执行入口

现有稳定入口：

```bash
npm run typecheck
npm test
npm run test:e2e:playwright -- tests/e2e/human-story.spec.ts --project=chromium
npm run test:e2e:playwright -- tests/e2e/mobile-human-story.spec.ts --project=chromium
npm run test:e2e:playwright -- tests/e2e/display-flows.spec.ts --project=chromium
```

真实 Codex / Claude dogfood 目前应作为 Linux 远端手动或 Agent 驱动 smoke 执行，不纳入默认 `npm test`。后续可以增加 `scripts/dogfood/run-swarm.js`，由它统一创建隔离实例、分配端口、启动浏览器、收集 artifact，并通过环境变量显式开启真实 agent：

```bash
FARMING_DOGFOOD_REAL_AGENTS=1 node scripts/dogfood/run-swarm.js \
  --target user@primary-linux \
  --stories real-codex-smoke-linux,real-claude-smoke-linux
```

该 runner 尚未实现前，真实 smoke 的执行原则是：一次只发极短 prompt，记录证据，不执行 quota reset，不修改真实用户配置。
