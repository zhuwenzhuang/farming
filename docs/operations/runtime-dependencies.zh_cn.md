# 运行依赖版本

> English version: [runtime-dependencies.md](./runtime-dependencies.md)

Farming 不把 Codex、Claude Code 和 `agent-browser` 等平台程序放进应用包。
每个 Farming 版本都会固定它们的精确版本、下载完整性、可执行文件入口和支持的
平台类型。

## 按 Runtime Mode 区分所有权

Runtime 选择面向两个相互独立的消费者：

- Native Terminal 采用系统优先策略。系统 Executable 存在时优先使用用户版本，
  只有在 Farming 自有 Executable 的已验证版本严格更高时才选择自有版本；版本相等
  时使用系统版本；系统候选不存在时才回退到 Farming 自有 Runtime。
- ACP 采用 Farming 自有策略。内置 ACP Adapter 及其 Provider Runtime 使用 Farming
  的精确 Pin，不得从 Server 环境继承 Terminal 选择出的 Executable。

Runtime Binding 与 Provider 启动路径必须分别保留这两条选择结果；同一个
`executablePath` 不得在没有显式证明的情况下同时承担两种策略。ACP Pin 应尽量更新到最新兼容版本，并且
只有在 Adapter Patch、Integrity、Protocol 以及 Chat/Terminal 切换验证通过后才接受。

准备完成的程序按“依赖、版本、平台”存放在 Farming 配置目录中，安装后保持不可变。
每次成功准备都会原子写入一份版本绑定，记录每个依赖实际选择的精确程序。正在运行的
Server 只有一个生效绑定；已经准备好的更新使用另一份尚未生效的绑定。

更新准备会在旧 Server 继续运行时下载并校验新 Farming 及其依赖，但不会替换当前
生效绑定。切换 Package 后，新 Launcher 会在开放 Server 端口前重新校验并启用新
绑定。发生回滚时，旧 Launcher 会重新启用旧绑定。

Farming 保留当前生效绑定，以及最近两份用于待更新或回滚的绑定。只有这三份保留
绑定都不再引用某个精确版本和平台时，Cache 清理才会删除它。清理失败会被记录，
但不会把已经健康启动的 Server 改判为启动失败。

可选 Docker 中的浏览器（实验性）使用的镜像和浏览器文件仍属于需要用户显式准备的容器依赖，
不进入宿主可执行程序的存储、选择和清理范围。

`farming runtime prepare` 会准备并启用当前版本绑定。部署和更新工具在进入重启窗口
前使用 `farming runtime prepare --no-activate`，因此正在运行的版本会继续使用原绑定。
