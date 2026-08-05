# Farming CLI

`farming` CLI 用于启动和维护服务，也为 Agent 提供实例精确的 Browser 等能力入口。

## 查看帮助

```bash
farming --help
```

常用命令：

| 命令 | 用途 |
| --- | --- |
| `farming daemon` | 在后台启动 Farming |
| `farming status` | 查看服务状态 |
| `farming url` | 输出当前访问地址 |
| `farming logs` | 查看服务日志 |
| `farming stop` | 停止服务 |
| `farming capabilities` | 查看当前实例能力 |
| `farming browser ...` | 使用 Farming Browser |

CLI 输出的 URL 可能包含访问 Token，不要放进公开日志。

## Agent 控制命令

Farming 提供用于发现能力、列出、启动、读取、发送消息和停止 Agent 的命令。这些命令主要服务于 Agent 内自动化或受控集成；普通用户优先使用 Farming Code。

完整签名、示例与错误语义见 [Agent 控制命令](./agent-control)。

## Browser CLI

Browser 使用逐步披露的帮助结构：

```bash
farming browser --help
farming browser help workflow
farming browser help navigation
```

完整流程见 [Agent 使用 Browser 的流程](../browser/agent-workflow)。

## 配置实例

只有需要隔离不同 Farming 实例时，才使用独立的 `--config-dir`。每个实例拥有自己的配置、进程和资源身份，不能混用 Token 或清理路径。

继续阅读：[服务管理](./service-management)。
