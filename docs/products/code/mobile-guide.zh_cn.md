# Farming 2 手机端使用介绍

> English version: [mobile-guide.md](./mobile-guide.md)

Farming 2 的手机端是一个随身远程工作台。它不追求把桌面 IDE 塞进手机屏幕，而是让你离开电脑后仍然能回到同一台 macOS 或 Linux 开发机：看 Agent 是否还在跑、阅读结构化 Chat 或 Terminal、发一句补充输入、打开项目文件、搜索关键位置，必要时看一眼 git blame。

手机端与桌面端使用同一套 Farming Code 浅色或深色外观。

## 一次性用起来

前置条件：

- Farming 2 已经部署在一台手机能访问到的 macOS 或 Linux 开发机上。
- 这台机器上已经能直接运行 `bash` / `zsh`。
- 如果要启动 Codex 或 Claude Code，这台机器上也已经安装并登录对应 CLI。

使用步骤：

1. 在部署日志里找到 `Network` URL，例如：

   ```text
   http://linux-host:6694/farming?token=随机生成的俳句口令
   ```

2. 在手机浏览器里打开完整 URL。
3. 第一次打开成功后，浏览器会保存 `farming_token` Cookie；之后刷新或重新打开页面，会自动回到同一个 Farming 服务。
4. 如果希望像 App 一样使用，在系统浏览器中选择“添加到主屏幕”。安装所需的图标和 manifest 是公开的品牌静态资源；工作区、会话和 API 仍然需要 Farming Token。
5. 点击左上角菜单按钮打开 Projects / Agents 抽屉。
6. 选择已有 agent，或点击 `New Agent` 启动新的 `bash`、`zsh`、Codex 或 Claude Code。

## 手机端界面

手机端主要分成三块：

- 顶部栏：显示当前 terminal、文件、Search 或 History，以及本地 / 远程连接状态。
- 左侧抽屉：放 Projects、Agents、Files、Search、History 和系统状态。
- 主工作区：一次只聚焦一个 Chat、Terminal、文件编辑器、Review、搜索页或历史页。

这种布局适合“短时间回到现场”：先看当前任务，再决定是否介入。手机端不会同时铺开多个 pane，也不会把所有 agent 输出一起堆在屏幕上。

## 典型使用场景

### 1. 离开电脑后查看 agent 状态

1. 打开 Farming 2 手机 URL。
2. 顶部栏确认当前连接状态和 active agent。
3. 如果当前不是要看的 agent，点击左上角菜单，在 Projects 里切换。
4. 查看 terminal 输出，确认 agent 是在等待输入、仍在执行，还是已经完成。

期望体验：

- 页面刷新后仍能看到服务端正在运行的 agent。
- Chat 与 Terminal 内容来自 Farming 主机，不依赖手机本地进程。
- Chat 与 Terminal 使用同一套紧凑 Composer：空输入框聚焦前后不切换布局，模型入口在键盘弹出前也可直接触达。
- 页面宽度不出现横向溢出；长 terminal 行在 terminal 内部处理。
- Codex 运行过程默认只显示紧凑状态行，需要时再点开单步详情，避免连续展开占满屏幕。
- 结构化 Chat 的 queued follow-up、中断、权限卡片与 Tool 详情在手机宽度下仍可触达。
- 手机端使用系统键盘自带的听写，不额外显示网页语音按钮。

### 2. 轻量介入 terminal

1. 进入某个 agent terminal。
2. 在底部输入框输入一句命令或补充说明。
3. 点击发送按钮，或用手机键盘回车发送。
4. terminal 输出更新后继续观察。

适合输入：

- `pwd`
- `git status --short`
- `echo continue`
- 给 Codex / Claude Code 的短 follow-up

不适合输入：

- 大段代码粘贴
- 长时间交互式编辑
- 需要精细光标操作的 shell 会话

### 3. 启动一个临时 shell

1. 打开左侧抽屉。
2. 点击 `New Agent`。
3. 选择 `bash` 或 `zsh`。
4. 填写 workspace，例如 `/home/user/project`。
5. 启动后，手机端会进入这个新 terminal。

这个场景适合在外面快速确认机器状态、跑一条只读命令，或者给当前项目开一个临时观察窗口。

### 4. 打开项目文件

1. 打开左侧抽屉。
2. 在目标 Project 下点击 `Files`。
3. 用搜索框输入文件名、内容关键词，或 `path:line`。
4. 点击结果打开文件。
5. 打开文件后，左侧抽屉会自动收起，主区域聚焦 editor。

手机端 editor 适合查看文件、核对某一行、做小范围修改。不建议在手机上做大规模重构。

### 5. 查看 git blame

1. 打开一个 git 仓库里的文本文件。
2. 点击 editor 顶部的 blame 图标。
3. 每行左侧会出现提交日期和作者。
4. 点击某一行 blame 注释，可以查看提交摘要、commit、作者和时间。
5. 再次点击顶部按钮即可隐藏 blame。

手机端的 blame 列会自动压窄，优先保证代码正文仍然可读。大范围审查和逐行追历史仍然更适合桌面端。

### 6. 搜索和恢复历史

1. 打开左侧抽屉。
2. 点击 `Search` 查看全局搜索入口。
3. 点击 `History` 查看不在主页面的历史 session 和已结束运行。
4. 需要时从 History 恢复某个 session，再回到 terminal。

手机端的 Search / History 更适合“找回现场”和“快速切换”，不是替代桌面端的长时间整理工作。

### 7. 管理 agent

1. 在当前 agent 页面点击右上角更多按钮，或在左侧抽屉里打开 agent 操作菜单。
2. 支持双模式的 Agent 可以直接切换到 Chat 或 Terminal；也可以重命名、标记未读、置顶、归档，或复制工作目录。
3. 归档会把对应 agent 或 session 从主页面移走，之后可从 History 找回。

这些操作用于整理现场：把正在看的任务放前面，把临时任务收起来，让手机端列表保持可扫读。

## 手机端用户故事验收

下面是手机端达到可用状态时必须能走通的故事。

### 故事 A：远程回到现场

用户在手机浏览器打开 token URL，能看到当前连接状态、Projects / Agents 和 active terminal。刷新页面后，服务端 agent 仍然存在，terminal 输出不丢失。

验收点：

- 页面能在 390px 宽度下显示顶部栏和主工作区。
- 左上角菜单能打开 / 收起 Projects 抽屉。
- `document.documentElement.scrollWidth` 不大于视口宽度。
- WebSocket 重连后仍能显示 agent 状态。

### 故事 B：启动并介入 shell

用户在手机上启动一个 `bash` agent，进入指定 workspace，发送一条命令，并在 terminal 中看到输出。

验收点：

- `New Agent` 在手机端可触达。
- workspace 输入框可编辑。
- 启动后 active terminal 自动切到新 agent。
- 底部 composer 能发送命令。

### 故事 C：查看项目文件

用户从目标 Project 展开 `Files`，搜索 `README.md:2`，打开文件并看到 editor。

验收点：

- Files 搜索框在手机抽屉中可编辑。
- 打开文件后抽屉自动收起。
- 顶部栏标题变为当前文件名。
- editor 不造成页面级横向溢出。

### 故事 D：用手机看 blame

用户打开文本文件后点击 `Show git blame`，能看到紧凑的行级 blame，并能点击行注释查看详情。

验收点：

- blame 按钮不依赖右键，触屏可用。
- 窄屏下 blame 列宽保持紧凑，代码正文仍然可读。
- blame 详情可以关闭。

### 故事 E：整理现场

用户可以在手机端重命名 agent、标记未读、置顶、归档；归档后的对象会离开主页面，并在 History 中找回。

验收点：

- 更多菜单和 agent 菜单在手机端可触达。
- 菜单项支持触屏点击，也保留键盘焦点顺序。
- 归档后的 agent / session 不再干扰当前列表，但能从 History 恢复。

## 设计边界

手机端优先服务这些任务：

- 看 agent 进度。
- 给 agent 一句轻量输入。
- 快速启动 shell。
- 查文件、查行号、查 blame。
- 整理 agent 列表。

手机端暂不作为这些任务的主战场：

- 长时间写代码。
- 多文件重构。
- 大范围 code review。
- 复杂 merge / rebase。
- 精细 terminal TUI 操作。

这不是能力放弃，而是产品取舍：手机端负责把你带回远程现场，桌面端负责长时间深度工作。
