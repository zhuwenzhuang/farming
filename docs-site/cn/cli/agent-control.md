# Agent 控制命令

Agent 控制命令用于受控自动化。除 `skills` 外，大多数命令需要连接正在运行的 Farming 实例，并读取实例 Token。

## 连接与认证

默认情况下，CLI 会从默认配置实例的运行状态读取地址，并从同一配置目录读取 Token。使用非默认实例时，在命令中传入 `--config-dir <path>`。

在 Farming Agent Runtime 内执行时，CLI 还会获得当前 Agent 身份。`FARMING_CONTROL_URL` 和 `FARMING_TOKEN_FILE` 可用于外部自动化覆盖自动发现结果，但不是普通使用的必填项。

缺少 Token 时，命令会失败并提示先从 Farming Agent Session 启动，或设置 Token 文件。连接失败、HTTP 错误和请求超时都会返回非零退出码。

```bash
farming list --config-dir /path/to/farming-config --json
```

## 命令一览

| 命令 | 结果 |
| --- | --- |
| `farming skills` | 输出 Main Agent 可使用的 Farming Skill 说明 |
| `farming capabilities [--json]` | 读取 Browser 与实验性 Computer 的当前能力 |
| `farming list [--json] [--parent <agentId>]` | 列出 Agent，可按 Parent 过滤 |
| `farming spawn [options] -- <command...>` | 在指定 Workspace 启动 Agent 或命令 |
| `farming output <agentId> [--tail <chars>]` | 读取 Agent 最近输出 |
| `farming send <agentId> <text...>` | 向 Agent 输入发送一行文本 |
| `farming title <concise-title...>` | 在当前 Agent Runtime 内更新自己的标题 |
| `farming kill <agentId>` | 停止并删除目标 Agent |

## skills

```bash
farming skills
```

该命令不接受参数，也不需要连接 Server。输出用于告诉 Main Agent 如何发现和使用 Farming 的受支持能力。

## capabilities

```bash
farming capabilities
farming capabilities --json
```

输出 Browser 和 Computer 的 `available`、`unavailable` 或 `disabled` 状态，以及当前可用的下一步命令。Computer 仍属于[实验性功能](../experimental/computer-use)。

## list

```bash
farming list
farming list --json
farming list --parent "$FARMING_AGENT_ID"
```

普通输出每行包含 Agent ID、命令、状态、当前目录，以及可用时的 Parent 和 Task。自动化应使用 `--json`，不要解析面向人的文本格式。

## spawn

```bash
farming spawn --workspace /repo --task "运行聚焦测试并总结失败" -- codex
farming spawn --workspace /repo --json -- bash -lc "npm test"
```

完整签名：

```text
farming spawn [--workspace <path>] [--task <text>]
  [--parent <agentId>] [--json] -- <command...>
```

`--workspace` 限定新 Agent 的工作目录；`--task` 同时成为任务说明和初始输入。成功时普通输出为 `Started <agentId>`，JSON 模式返回 `agentId`。

可执行命令不能为空。带空格或引号的参数会作为一个完整参数转交，不需要调用方手工拼接 Shell 字符串。

## output

```bash
farming output agent-123
farming output agent-123 --tail 2000
```

默认读取最近 4000 个字符。`--tail` 的单位是字符，不是行数。目标不存在或 Server 无法读取时命令失败，不会返回伪造的空成功。

## send

```bash
farming send agent-123 "请运行刚新增的回归测试"
```

CLI 会在文本末尾补充回车，并在 Server 接受输入后输出 `Sent`。传输超时意味着结果可能不确定；先检查 Agent 输出，再决定是否重发。

## title

```bash
farming title "修复 History 请求乱序"
```

`title` 只能在当前 Farming Agent Runtime 内使用，用来更新自己的简洁标题。外部 Shell 缺少 Agent ID 或标题 Token 时会失败。

## kill

```bash
farming kill agent-123
```

成功后输出 `Killed`。这是破坏性操作：先通过 `list` 和 `output` 核对精确 Agent ID，并确认不再需要它拥有的运行状态和资源。

## Browser 与 Computer

- `farming browser --help`：Browser Resource、导航、交互和检查命令。
- `farming computer --help`：实验性 Computer 工具与工作流。

Browser 参考见 [Agent 使用 Browser 的流程](../browser/agent-workflow)。
