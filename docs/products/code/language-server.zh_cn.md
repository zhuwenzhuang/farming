# Language Server

> English version: [language-server.md](./language-server.md)

状态：首个面向代码查看的 MVP。

## 产品边界

Language Server 是 Farming 内置插件，用来复用已经运行在 VS Code 内的语言能力。Farming 不安装、启动、停止、重启或配置 VS Code 及各个 Language Server，也不提供 Provider、Command、Args、Socket、初始化参数或每语言配置表单。

首版只有一条产品路径：

```text
Farming Monaco 编辑器
        |
        | Farming 已认证 HTTP API
        v
Farming 后端
        |
        | 回环地址、Token 认证的 Bridge 协议
        v
Farming VS Code Bridge 扩展
        |
        | VS Code 公共语言 Provider 命令
        v
已有 VS Code 扩展及其 Language Server
```

原生 VS Code Server 没有向外部应用公开语言 Provider 查询接口，因此一个很小的 VS Code Bridge 运行在已有 Extension Host 内。它只调用 VS Code 公共 Provider 命令，各语言扩展的配置和生命周期仍完全归 VS Code。Bridge 由用户管理：Farming 只发现并连接，不负责安装或启动。

Bridge 是运行在已有 VS Code Extension Host 内的纯 JavaScript，不会在 glibc 2.17 等老系统上增加另一套原生运行时要求。Language Server 是否兼容，仍由用户已有的 VS Code 扩展决定。

## 首版能力

实现与语言无关、按能力工作：

- Hover；
- 转到定义、引用和实现；
- 文档符号和工作区符号；
- 可惰性递归展开的传入/传出调用层次结构；
- 可惰性递归展开的父类型/子类型层次结构；
- 诊断。

只要对应 VS Code 扩展已经安装、激活并实现相应 Provider，同一条路径就适用于 TypeScript、JavaScript、Python、Go、Rust 和其他语言。不支持的层次结构或符号 Provider 会明确提示；Provider 已支持但没有匹配项时才显示空结果。Farming 不会用 References 伪造调用层次结构。

Completion、Rename、Formatting、Code Action 和 Farming 托管安装 Language Server 不在首版范围。语言查询使用上次保存的文件。Farming 文件存在未保存修改时仍可正常做语法编辑，但暂时隐藏 Bridge 操作并清除远端诊断，避免把 VS Code 中的旧文本结果冒充当前结果。

## 状态模型

Farming 后端拥有权威连接状态：

- `Unavailable`：没有发现 Bridge 描述文件；
- `Connected`：发现的 Bridge 在有界时间内通过认证健康检查；
- `Error`：描述文件存在，但无效、不兼容或无法连接。

打开插件页会做一次新的有界发现；重试会使短缓存失效。请求失败会使当前 Bridge 失效，下一次操作重新发现。Farming 不会把 Bridge 缺失或失败降级成质量更差的 Language Server 路径。

每个 VS Code 窗口都会在 VS Code Global Storage 下写入权限为 `0600` 的实例描述文件，其中包含随机 Bearer Token 和随机回环端口。Farming 对有界的已发现实例集合做健康检查，合并能力，并按精确 Workspace 把每个 Project 请求路由到正确 Bridge。Farming 只接受当前用户拥有的字面回环 HTTP 端点。后端使用权威 Project 根目录校验每个输入文件，并在返回浏览器前剔除同一根目录之外的所有结果。Bridge 也会独立校验：只接受当前 VS Code 窗口已打开的 Workspace，以及属于该 Workspace 的文件。

层次结构句柄不透明、只在 Bridge 进程内有效，有容量上限并在十分钟后过期。Bridge 丢失或重启后，旧句柄会明确失败，用户重新准备层次结构即可。

## 用户管理的 Bridge

参考 Bridge 源码位于 `extensions/language-server/vscode-bridge`。开发时可用 VS Code 官方扩展打包器打包，再通过 VS Code 安装：

```bash
cd extensions/language-server/vscode-bridge
npx @vscode/vsce package
code --install-extension vscode-bridge-0.1.0.vsix
```

使用 Remote SSH 时，从 VS Code 扩展视图把扩展安装到远端主机，并保持对应 VS Code Workspace 打开。扩展在 VS Code 启动后激活并发布描述文件，Farming 会自动发现，不需要任何 Farming 配置。

标准发现位置覆盖 VS Code Server、VS Code Server Insiders、旧版 VS Code Remote、桌面 Code 和桌面 Code Insiders 的 Global Storage。扩展 ID 和存储身份都是 `farming.vscode-bridge`。
Bridge 支持 VS Code 与 VS Code Server 1.85 及以上版本，已有远端安装无需仅为 Farming 单独升级。

## 验证

后端回归测试覆盖认证发现、协议健康检查、Project 根目录输入约束、返回结果过滤和重新回到 Unavailable。前端类型检查覆盖 Monaco Provider 注册及层次结构/符号面板。生产形态验收还应使用真实 VS Code Remote SSH Workspace，先验证 TypeScript 的定义、引用和调用层次结构，再验证同一 VS Code Server 中安装的一种非 TypeScript 语言扩展。
