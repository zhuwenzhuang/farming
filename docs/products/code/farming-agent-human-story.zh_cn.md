# Farming Code 类人验收故事

> English version: [farming-agent-human-story.md](./farming-agent-human-story.md)

这是 Farming Code 面向普通用户的标准验收路径。它从冷启动浏览器开始，让同一个项目依次经过 Chat、Terminal、Files、History 与刷新，检查用户真正看得到的行为。

## 故事 1：在真实项目里开始工作

目标：不必先理解 Main Agent，就能创建一个项目 Agent。

1. 打开 `/farming/` 的 token URL。
2. 确认工作台已连接，**New Agent** 可用。
3. 选择 Codex、Claude Code、OpenCode、Qoder、bash 或 zsh。
4. 选择已有 workspace 并启动。
5. 确认新行出现在对应项目下，并成为 active Agent。

期望：

- 首次使用从 **New Agent** 开始，不强制配置 Main Agent；
- coding Agent 只有在 executable/runtime 可用时才可启动；
- Agent 在用户选择的 workspace 中运行；
- 重新打开同一页面不会复制一份进程。

## 故事 2：在结构化 Chat 中完成任务

目标：让 coding Agent 检查并修改一个小功能，同时保留证据。

1. 用 **Chat** 启动受支持的 coding Agent。
2. 发送一个需要读文件并汇报修改的请求。
3. Turn 执行时观察当前过程折叠区。
4. 展开一条 Tool 或文件修改卡，再收起。
5. 完成后发送 follow-up。

期望：

- 用户消息、过程 entry、Tool 与结果保持 ACP 原始顺序；
- Turn 完成后最终结果重新成为视觉焦点；
- Tool 详情和准确历史 patch 仍可展开；
- 内部 heartbeat/context envelope 不进入用户对话；
- Turn 运行时发送的新消息进入可见队列，idle 后自动发送，除非用户主动丢弃；
- 中文输入法、Enter/Shift+Enter、附件与草稿历史符合普通聊天框习惯。

## 故事 3：修改 runtime 设置时不自欺

目标：修改模型或速度，并明确哪个 runtime 会收到变化。

1. 打开兼容 Codex Session 的模型控件。
2. 拖到另一个模型/推理终点。
3. 实时 capability 支持时切换 Fast 或 Ultra。
4. 展开再收起 **Advanced**。
5. 发送下一条消息。

期望：

- 拖动圆心停在目标点，profile label 与选择一致；
- Advanced 保留同一 profile，菜单过渡不闪烁、不跳尺寸；
- 不可用的 Fast 或 Ultra 保留为灰色禁用态；
- ACP 用返回的 live Session snapshot 校准状态；
- 原生 Codex Terminal 在下一条消息前应用兼容的 model/Fast 变化，不只是影响以后启动。

## 故事 4：安全切换 Chat 与 Terminal

目标：查看准确 CLI 行为，同时不丢失会话。

1. Agent idle 时从 Chat 切到 Terminal。
2. 确认同一个 provider Session 在真实 PTY 中恢复。
3. 发送 Terminal 输入，并等待 provider 记录落盘。
4. 切回 Chat。
5. 刷新浏览器。

期望：

- Chat / Terminal 切换的是实际 runtime，不是隐藏某个 view；
- 尚未输入的新 Terminal 可以直接进入 Chat；
- Terminal 一旦收到输入，缺少可恢复 provider 记录时必须阻止切换并给出可操作错误；
- 目标 runtime 启动失败会恢复原 runtime；
- Farming host 仍运行时，刷新浏览器不会丢掉 active Agent 与输出。

## 故事 5：在 Chat 之外验证修改

目标：检查文件、审查修改，并在之后找回任务。

1. 展开项目 Files。
2. 搜索 `path:line`，打开文件并显示 Git blame。
3. 打开 Changes 或 Review，检查准确 diff。
4. 归档 Agent。
5. 在 History 搜索标题并恢复。

期望：

- Files 留在项目滚动流里，不产生第二个项目级嵌套滚动条；
- 文件操作始终限制在 workspace root 内；
- Agent 继续输出时，blame、diff 与 editor 状态保持稳定；
- History 可以找到浏览器第一页之外的旧 provider Session；
- 临时 shell runtime 归档后销毁，受支持 provider Session 保持真实 resume 语义。

## 故事 6：从手机回到现场

目标：离开桌面后检查同一项任务。

1. 在 390px 宽度打开 token URL。
2. 打开项目抽屉并选择正在运行的 Agent。
3. 阅读最新结果并发送一句 follow-up。
4. 打开 Files 检查一个位置。
5. 刷新并确认同一 Agent 仍可见。

期望：

- 页面没有 document 级横向溢出；
- 抽屉不会挤压聚焦的 Chat/Terminal 主区域；
- 软件键盘打开时 Composer 仍可触达；
- 设备已有系统听写时，手机端不再重复显示网页语音控件。

## 自动化覆盖

类人路径拆到多组确定性 Playwright 测试中，避免一个脆弱的大型端到端用例：

- `tests/e2e/acp-human-cases.spec.ts`：结构化 ACP Chat；
- `tests/e2e/model-matrix.spec.ts`：实时 ACP 与 Terminal 模型控件；
- `tests/e2e/terminal-regression-matrix.spec.ts`：PTY 输入、滚动、选择与恢复；
- `tests/e2e/additional-user-scenarios.spec.ts`：启动、Files、History 与生命周期；
- `tests/e2e/iphone-mobile-layout.spec.ts` 与 `tests/e2e/mobile-human-story.spec.ts`：手机布局与介入；
- `tests/e2e/review.spec.ts`：Review 数据与交互。

迭代期间运行 focused coverage，发布前再扩大：

```bash
npx playwright test tests/e2e/model-matrix.spec.ts --project=chromium
npx playwright test tests/e2e/acp-human-cases.spec.ts --project=chromium
npm run test:e2e:playwright
```

Fake coding executable 用于确定性 CI 覆盖；真实 Codex / Claude Code smoke 仍保持显式、低频和隔离。
