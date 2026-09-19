# 运行依赖版本

> English version: [runtime-dependencies.md](./runtime-dependencies.md)

Farming 固定 Codex、Claude Code 和 `agent-browser` 等平台程序的版本。
每个 Farming 版本都会固定它们的精确版本、下载完整性、可执行文件入口和支持的
平台类型。

## agent-browser 临时源码固定版本

所有发行形式携带 `0.32.3-farming.1`：以官方 0.32.3 为基础，采用
[上游 PR #1527](https://github.com/vercel-labs/agent-browser/pull/1527) 的 stderr 排空修复，
由 Farming 构建。启动器在发现端点后持续读取 Chrome 的 stderr，防止长期运行后
未消费的管道写满、阻塞浏览器。此修复不保留无限诊断日志，也不修改 Chrome。

**在官方版本包含这项修复之前，不得升级 agent-browser。** 切回官方制品前，
必须核对实际发布源码，并通过真实启动路径的 stderr 饱和回归测试及 Farming Browser
冒烟测试；版本号更高本身不是升级依据。源码固定信息和已审查补丁是权威来源，
例行依赖更新不得改变它们。

原生构建依次完成精确上游提交与补丁校验、启动器测试、包含 dashboard 的 release
构建，以及平台身份与摘要生成。打包只接受选定 Farming 提交的完整原生制品。
制品缺失、身份不匹配或损坏均为终止错误，不能回退下载未修复的 npm 程序。
运行时验证包内身份和可执行文件摘要；独立 CLI 的快照资产先复制到既有不可变缓存
再执行。准备过程突然中断不会激活绑定；下次准备在既有依赖锁下验证或重建缓存。

源码开发者显式执行
`node scripts/build-agent-browser-runtime.mjs --platform <platform> --output <artifact-root>`，
前端构建后，将 `FARMING_AGENT_BROWSER_ARTIFACTS` 指向该目录并执行
`npm run prepare:packaged-runtimes -- --platform <platform>`。
Rust 与 pnpm 版本由源码元数据固定。发行打包前构建所有支持平台；普通前端与单元
测试构建不会静默编译或下载替代 Browser 运行时。

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
