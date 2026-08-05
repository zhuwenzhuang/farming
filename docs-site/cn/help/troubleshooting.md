# 故障排查

排障时先确定失败发生在哪一层：Farming 服务、Provider、Project、Browser，还是实验性能力。

## Farming 无法打开

```bash
farming status
farming logs
```

如果服务没有运行：

```bash
farming daemon
```

如果 Host 本机可以打开、另一台设备不能打开，检查网络连通性、防火墙、反向代理和访问地址。不要为了快速验证而把 Farming 无保护地暴露到公网。

## 安装后找不到 farming 命令

先检查 npm 全局目录：

```bash
npm config get prefix
command -v farming
```

在 macOS 和 Linux 上，全局可执行文件通常位于输出 Prefix 的 `bin/` 目录。确认它已经加入 `PATH`，然后重新打开 Shell。不要通过复制 `farming` 文件到随机系统目录来绕过安装问题。

## 端口或配置实例冲突

如果日志显示端口已占用，先运行 `farming status` 确认当前配置目录是否已经拥有一个 Server。需要第二个实例时，使用明确的独立配置目录和端口：

```bash
farming daemon --port 6794 --config-dir /path/to/another-farming-config
```

不要让两个实例共享同一可变配置目录，也不要停止一个身份不明确的 PID。

## Agent 无法启动

1. 在 Host 的普通 Shell 中直接启动对应 Coding CLI。
2. 确认登录有效。
3. 确认 Workspace 存在且 Farming 有权访问。
4. 回到 Farming 重新启动 Agent。

Provider 可执行文件存在，不代表登录、模型或 Session 能力已经可用。

登录曾经可用但后来失败时，在普通 Shell 中重新启动 Provider CLI，检查账号状态、更新提示和当前可用模型，再返回 Farming。

## Chat 卡住或连接中断

- 先查看 Agent 当前显示的状态；
- 重新打开 Agent 或刷新页面；
- 检查文件和 Git 状态是否已经发生变化；
- 不要在结果不确定时立即重复发送同一个修改请求。

## Terminal 没有输出

- 确认 Agent 仍在运行；
- 检查是否停在需要输入的提示；
- 重新打开 Terminal，让 Farming 从后端状态恢复；
- 查看服务日志中的 PTY 或进程错误。

## Browser 不可用

```bash
farming capabilities
farming browser capability
```

打开 **插件 → 浏览器** 查看当前 Browser Source 和依赖状态。普通安装不会自动下载隔离浏览器依赖。

本机 Chromium 路径失效时，确认浏览器仍安装在 Host 上。隔离 Browser 准备失败时，检查容器运行时是否可用、磁盘空间是否足够，以及日志中最早出现的准备错误。

## 更新失败

先记录 Settings 中显示的当前版本、目标版本和安装来源，再查看 `farming logs`。网络失败可能发生在下载、准备或激活阶段，不要在结果不明确时连续点击更新。

如果是 npm 安装，可以在普通 Shell 中运行：

```bash
npm install --global farming-code@latest
```

完成后重新启动 Farming，并在 Settings 中确认实际版本。

## Files 读取失败

确认路径属于当前 Project Workspace，没有通过符号链接逃出授权根目录。大型搜索应缩小路径和关键词。

## 实验性功能失败

Farming Desktop、Computer Use 和 Language Server 可能因为依赖、远程环境、语言工具链或真实案例覆盖不足而不可用。问题报告中明确标注“实验性”，并提供环境、前置条件、复现步骤和可见错误。

## 报告问题

在 [GitHub Issues](https://github.com/zhuwenzhuang/farming/issues) 中提供：

- Farming 版本；
- Host 操作系统和 Node.js 版本；
- Provider 或相关能力；
- 最小复现步骤；
- 用户可见的精确错误；
- 已清理敏感信息的相关日志。

日志默认属于当前 Farming 配置实例。使用自定义 `--config-dir` 时，必须从同一个配置实例读取日志。优先搜索失败时间附近的 `error`、`failed`、`timeout`、Provider 名称或 Browser / PTY 相关信息，而不是提交整份长期日志。
