# Codex Runtime 模式

> English version: [codex-runtime.md](./codex-runtime.md)

Codex Chat 使用 ACP，Terminal 使用原生 PTY。通用执行、配置、Transcript 和恢复遵循
[ACP Runtime](acp-runtime.zh_cn.md)、[Terminal 状态](terminal-state-protocol.zh_cn.md)及
[Provider Session 身份](provider-session-identity.zh_cn.md)。本篇只记录 Codex 特有边界。

## Executable 与进程所有权

Chat 使用 Farming 固定版本的 Adapter/Runtime，绑定确切 Agent Home；已有 Session 保留
原启动身份。Terminal 独立选择 Executable，并带 `--no-daemon` 启动，确保能停止完整自有
进程树，不留下共享 Codex Server。

同一 Agent Home 的原生启动在权威 TUI readiness 前串行，因为共享 Home 存储。共享
Terminal coordinator 拥有队列、期限与清理，Adapter 只声明约束；不同 Home 相互独立。

## Session 连续性

新 Terminal 使用 Farming 临时身份。用户输入后，History、恢复、Fork 和 Runtime 切换
要求已证明的可恢复 Provider Session。当确切 Runtime 空闲时，一次有界 `/status` 探测
可从结构化已渲染面板确认身份；任意输出、模型名称和未确认写入都不是证明。探测保留未
提交草稿，不自动重发不确定输入。

Chat/Terminal 通过真实 Runtime 替换保留已确认对话。身份未确认时切换控件仍可见但禁用；
停止后的未确认 Agent 可检查，但不声称可恢复。保存配置的恢复和失败回退由共享 ACP 契约负责。

共享 Codex Session 释放要求确切 `thread/closed` 确认或显式 `notLoaded`；unsubscribe
已接收不代表 writer 已释放。失败、断连或超时阻止替换，无关 Session 保持运行。
Managed app-server 不保留已退订的空闲 thread。

活动 Turn 的 Fork 使用 Provider `beforeTurnId` 边界，排除未完成输出且保持来源继续运行。
Provider 分配 Turn 身份前不可用；子环境与所有权隔离遵循共享 Fork 契约。

## Adapter 与原生控件

能力来自实时握手和 Session 状态，不来自 Codex 名称。媒体、工具结果、diff、权限和子
活动保持结构化；原生元数据与扩展在 Adapter 边界归一化。独立工具结果及音频可检查，实时
转写片段按条目身份更新，认证恢复和严格检查提示可见。账户/项目/队列清单及模型配置不是
Agent 活动。

原生 profile 事务选择确切模型、推理和速度身份，共用一个有序输入屏障和期限；只有 picker
关闭且最新渲染屏幕确认了请求 profile 才成功。打开的菜单、旧 footer 和剥离 ANSI 的文本
不是确认。取消与未知结果不能重放选择或 toggle。

Composer 使用已公布模型目录与推理选项，保留版本标签和未知模型家族；样式不能过滤可选模型。

## HTML 可视化边界

只有 Provider 归一化的宿主可视化指令启用脚本预览，普通 HTML 链接不启用。绝对路径指向
后端可读文件，只有文件名的引用从来源 Codex Home 解析。Fork/恢复保留路径，不复制文件或
生成不可变快照。

认证 owner 为一个规范 UTF-8 HTML 文件（最多 2 MiB）及依赖目录创建短期、不可猜测的
preview lease。显式 resource root 必须包含 HTML，不能是文件系统根目录。路径穿越和
符号链接逃逸拒绝；只读分享不能创建 lease。

Resource GET capability 不依赖环境登录凭据，只暴露该 lease 的目录。Iframe 允许脚本，
不允许 same-origin、表单和顶层导航；CSP 只允许 lease 与受支持可视化 CDN 资源，不开放
Farming API。直接导航资源时禁用脚本并 sandbox。Frame 消息核对来源且有界。

后端拥有 lease 生命周期，renderer 拥有可取消加载/续期。过期、重启和加载失败明确终止；
迟到结果释放 lease，卸载删除 lease，不同视图独立。Retry 不重放 Agent 工作。资源/脚本
错误与仍可用内容一起展示。

HTML 作者拥有图表布局。打包的片段兼容层提供主题和通用控件，完整文档保留自己的样式。
主题、续期和全屏保留 iframe 与交互状态，不重跑脚本。尺寸测量有界且离屏仍可工作，
Transcript 滚动保留既有阅读所有权。Widget 状态是本地展示状态，不是 Agent 上下文；
跟进请求通过 Composer。

## 验收标准

覆盖确切 Home/进程所有权、启动串行、身份探测与未提交草稿、profile 确认、Chat/Terminal
连续性、writer 释放、活动 Turn Fork 及未知结果恢复。可视化覆盖资源隔离、过期、取消、
迟到结果和 Light/Dark/Paper、窄屏下交互保留。两种 Runtime 使用隔离、低流量真实 Codex 验证。
