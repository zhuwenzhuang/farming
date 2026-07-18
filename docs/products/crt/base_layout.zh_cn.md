# 布局设计基础

> English version: [base_layout.md](./base_layout.md)

本文档定义 CRT 皮肤跨平台通用的布局概念、数据模型和视觉规则。当前支持的桌面规则见 `pc_layout.zh_cn.md`；`mobile_layout.zh_cn.md` 仍是概念设计，不属于当前产品界面。

---

## 1. 整体 Layout 结构

页面由三个常驻区域组成：

| 区域 | 职责 |
|------|------|
| TopBar | 顶部状态栏，显示系统资源和关注提示 |
| Agents Layout | 中央区域，展示所有工作 agent 的状态 |
| Sidebar | 菜单入口和 Main Agent 面板 |

> 组件文件名 `MapView.tsx` 对应的是 Agents Layout 区域。

---

## 2. TopBar（顶部状态栏）

### 2.1 内容项

从左到右排列为一行：

| 项目 | 格式 | 说明 |
|------|------|------|
| Agents | `AGENTS: {active}/{total}` | 活跃/总数 agent 计数 |
| Token 速率 | `TOK/MIN: ~{rate}` | 最近五分钟所有终端输出的 token 估算速率 |
| CPU | `CPU: {n}%` | 系统 CPU 占用 |
| MEM | `MEM: {n}%` | 系统内存占用 |
| Focus | `Focus: {name}` | 当前正在查看的 agent 名称（仅当 session 打开时显示） |
| Attn | `Attn: {name} [{score}]` | 最高注意力分数的 agent（仅当无 focus 且有活跃 agent 时显示） |
| Uptime | `UPTIME: {time}` | 系统运行时长，始终靠右对齐（`margin-left: auto`） |

### 2.2 条件显示逻辑

- **Focus** 和 **Attn** 互斥：当 session 弹窗打开时显示 Focus，否则显示 Attn
- **Attn** 分高温/常温：`score >= 70` 时加 `.hot` class，文字变为红色并闪烁
- Uptime 始终是最后一项，通过 CSS `last-child { margin-left: auto }` 推到最右

### 2.3 设计原则

- **信息密度高、视觉干扰低**：小字，不使用图标
- **不催促**：没有告警角标或红点，Attn 指示器只是提示哪个 agent 最活跃
- **全静态布局**：不随内容变化而跳动，条件项出现/消失不影响其他项位置

---

## 3. Sidebar（菜单栏）

桌面端侧栏菜单项统一使用大写标签：**SEARCH**、**HISTORY**、**EXTENSIONS**、**BILLING**（以及基础的 **NEW AGENT**、**SETTINGS**）。僵尸标记与治理在 Agents Layout / 后端规则层呈现，**不设独立「Zombies」侧栏菜单**。

### 3.1 菜单项

每个菜单项对应一个全局快捷键（自上而下顺序：搜索 → 历史 → Extensions → Billing，上下为会话入口与设置）：

| 快捷键 | 功能 | 状态 |
|--------|------|------|
| N | New Agent | enabled |
| F | Search | enabled |
| H | History | enabled |
| E | Extensions | planned |
| $ | Billing | enabled |
| S | Settings | enabled |

- **enabled** 项可点击，hover 时背景变亮
- **disabled** 项 `opacity: 0.5`，`cursor: not-allowed`，不可交互（当前无占位项）

Search 取代原先的 Task List 位置，在 Agents Layout 区域打开占满高度的搜索视图；查询提示符持续保持焦点，并把当前项目 Agent 与共享后端搜索接口返回、且未被实时 Agent 占用的 provider session 结果合并展示。

当 Main Agent 是唯一的实时 Agent 时，Agents Layout 保持明确的空状态，并提供可通过键盘导航的 `[N] New Agent` 操作。启动第一个项目 Agent 后，提示由正常实时网格替代；移除最后一个项目 Agent 后提示恢复，Main Agent 不会因此被隐藏或重启。

Billing 用占满高度的 token 遥测视图取代原占位入口。Days 是默认视图：紧凑的 52 周日历热力图让每一天都可直接选择，同时不再为每天占用一整根全高竖柱。无 Token 日期保持明确的空状态，低于 1B 的日期使用从靛蓝到高热红的五档相对热度光谱；达到 B 级后脱离相对色阶，用紫外超量程符号表达绝对层级：点、环、菱形、星标分别表示 `1B`、`2B`、`4B`、`8B+`。相对分档仅依据可见范围内低于 1B 的非零日期计算，Tooltip 则保留精确数值。

Processed 总量包含 cache read，并合并所有已配置 Codex、Claude Home 与可读取的 OpenCode export；无法提供 Token 字段的 provider 会明确标出。顶部紧凑汇总今天、近 7 天、近 30 天、52 周、活跃日、B 级日期和峰值日。选择当天会通过服务端有界的 5 秒缓存强制读取一次最新明细。刷新期间保留上一帧完整小时曲线和稳定的 `READY` 状态；不完整的新快照或瞬时扫描失败不能清空已有小时格。有旧帧的连续失败会稳定显示 `STALE`，首次加载明细失败只有在一次有界重试后才进入 `DAY SIGNAL LOST`。Today 汇总、所选日期的 Total、Input、Output、Cache Read/Write 和日内峰值计数器只对正向差值做补齐动画，历史数值保持静态。下方还保留 24 个本地小时的 total/cache 阶梯波形、与 `00:00`–`24:00` 仪表标尺对齐的 24 格可选择小时带、带精确 Tooltip 的常驻紧凑读数，以及 provider 归属占比；切换选中日时复用日事件缓存，不重新扫描历史。左右键按天移动，上下键按周移动。Live 作为二级视图继续显示最近 60 分钟的 Canvas 示波器、当前信号、积分、峰值速率和活跃时间桶。provider 通道和额度窗口保持可见，不虚构金额或后端拿不到的额度。按 `$` 打开 Billing，`D` 与 `L` 切换视图，`R` 刷新，Escape 返回 Agent 主页。

### 3.2 Main Agent 面板

- 仅当存在 main agent 时渲染
- 红色边框（`--theme-border-error`），与普通 agent 的绿色边框区分
- 标题栏 `MAIN AGENT [0]`：红色文字 + 红底白字的 `[0]` 徽章
- 点击打开 main agent 的 session 弹窗

### 3.3 设计原则

- **键盘优先**：每个菜单项都有对应的全局快捷键，sidebar 本身更多是视觉提示
- **Main Agent 特殊待遇**：红色视觉强调，不参与 agents layout 的注意力排序

---

## 4. 注意力评分系统

每个非 main agent 有一个 0-100 的 `attentionScore`。活跃度档位由后端 `backend/agent-manager.js` 与上述分值映射一致并下发；前端只做展示与排序，不由 Main Agent 实时决策。

### 4.1 评分维度

| 维度 | 分值范围 | 规则 |
|------|---------|------|
| 状态权重 | 0-20 | running=20, pending=15, stopped=5, dead=0 |
| 活跃度 | 0-40 | hot(&lt;30 分钟)=40, warm(&lt;3 小时)=30, cool(&lt;12 小时)=15, cold(≥12 小时)=0 |
| 输出速率 | 0-30 | 基于近 30 秒内输出事件频率和字节量 |
| 僵尸惩罚 | -10 | 如果是僵尸则扣分 |

输出速率公式：`min(30, round(eventsPerSec * 6 + bytesPerSec / 50))`

### 4.2 活跃度等级（activityLevel）

基于距上次活动时间（`lastActivity`：输出、会话流等会刷新；档位刻意拉长以免 UI 上过快从 hot 跌入 cold）。

| 等级 | 条件 | 含义 |
|------|------|------|
| hot | 距上次活动 **&lt; 30 分钟** | 近期仍有明确动静 |
| warm | **&lt; 3 小时** | 仍可算在关注窗口内 |
| cool | **&lt; 12 小时** | 明显变温 |
| cold | **≥ 12 小时** | 长期无活动（仍早于僵尸线） |

### 4.3 僵尸判定

满足以下全部条件的 agent 被标记为僵尸（`isZombie: true`）：
- 状态为 `running`（进程还活着）
- 不是 main agent
- 距上次活动 **严格大于** `AgentManager.ZOMBIE_IDLE_MS`（当前为 **72 小时**，见 `backend/agent-manager.js`）

当前该判定会触发周期性 zombie sweep（默认每 60 秒），命中后自动执行 kill，并将记录归档进 History。

### 4.4 Main Agent 豁免

Main agent 不参与注意力评分、冷热判定和僵尸检测。它在 sidebar 中独立展示，不出现在 agents layout 中。

---

## 5. Agent 卡片结构

每个 agent 卡片由两部分组成：

### 5.1 Title Bar

固定单行密度的标题栏（`padding: 6px 10px`，主标题 `12px`、粗体；底部分割线跟 `--agent-color`）。Session 弹窗顶栏 **另行更扁、更淡**，见 **5.3**，不与卡片完全同一套数字。包含：
- agent 命令名（左侧，占满剩余空间）
- 状态元信息：活跃度等级、注意力分数（右侧，小字半透明）
- 僵尸标记 `ZOMBIE`（如果是僵尸）
- 键盘快捷键徽章 `[1]`-`[9]`（最右侧，反色底）

Title bar 的文字和边框颜色跟随 `--agent-color`（由活跃度等级决定）。

### 5.2 Body

填满剩余空间，包含：
- 工作目录路径（小字，非 compact 模式）
- 输出预览（flex: 1，填满剩余空间，pre-wrap）

### 5.3 Session 终端弹窗顶栏

点击地图卡片打开的全屏/模态终端（`SessionModal`）顶栏刻意比地图卡片 **更克制**（扁、淡）：弹窗是沉浸操作区，标题栏不应抢注意力。

| 项目 | 规则 |
|------|------|
| 外框 `.modal-content` | **1px** 边框，色 `--theme-border-soft`；去掉 `fx-crt-panel` 在外壳上的外发光，避免边框「视觉上像两条线」 |
| 顶栏 padding | `4px 8px` |
| 标题 `.session-title` | `11px`、`font-weight: 600`、偏柔和的 `--theme-fg-soft`；文案为命令名 + `(agentId)` |
| Kill / Close | 再紧凑一档：`padding` 约 `3px 8px`、`font-size` `10px` |
| 顶栏底部分割线 | **1px** `--theme-border-soft`（与地图卡片上亮绿边框区分，偏静） |
| 终端内容区 `.terminal-container` | 内边距 `6px` |
| **ghostty 画布字号** | 桌面 **`13px`**、视口 `max-width: 980px` 时 **`11px`**（`SESSION_TERMINAL_FONT_DESKTOP` / `SESSION_TERMINAL_FONT_MOBILE`；创建 session 时按断点选定，见 `src/lib/ghostty.ts`、`terminal-session-pool.ts`） |

移动端 Menu 按钮与顶栏同密度（`min-height` 约 `28px`、`4px 8px` padding）；下拉菜单容器边框同为 **1px** `--theme-border-soft`。底部 **`mobile-terminal-input`** 仍为 **`16px`**，避免 iOS 聚焦放大页面，与终端画布字号分开处理。

### 5.4 New Agent / Settings 模态框

`InputDialog`（快捷键 **N** / Start Main Agent）与 `Settings`（**S**）共用 **`.input-dialog`**、**`.settings-dialog`**、**`.dialog-header`**，视觉气质与 **§5.3 Session** 对齐——克制、细线、无对话框式厚重外发光。

| 项目 | 规则 |
|------|------|
| 外框 | **1px** `--theme-border-soft`；`fx-crt-panel` 在外壳上 **`box-shadow: none`** |
| 顶栏 `.dialog-header` | `4px 8px`；标题 **11px**、`font-weight: 600`、`--theme-fg-soft`；底边 **1px** 柔和分割线 |
| Esc | `.dialog-header .close-btn`：**10px** 字、紧凑 padding（与 Session Kill/Close 同档） |
| Agent / 主题选项 `.agent-item`、`.theme-option` | 软边框、正文 **11px**、辅助描述 **10px**、padding **6px 8px**（桌面） |
| Workspace 步骤 | 「Workspace:」与路径输入 **11px**；recent 列表 **11px**，与侧栏菜单密度接近 |
| `.workspace-actions`（Start / Back） | 桌面：**11px**、扁按钮；移动端底部 sticky 条仍用较大 **`min-height`** 兼顾触控 |

**移动端**：底部 sheet 布局不变；Workspace 路径 **`input`** 在 `max-width: 980px` 下仍为 **`font-size: 16px`** 与较高 **`min-height`**，避免 iOS 聚焦自动缩放整页（与 `mobile_layout` 输入策略一致）；列表项与按钮可略收紧，但路径输入遵循上述例外。

---

## 6. CRT 视觉效果

在 CRT terminal 皮肤下，不同状态的 agent 有不同的视觉反馈。屏幕纹理由 `frontend/skins/crt/styles/effects.css` 提供：使用平面泛绿暗底与静态单色扫描线，不再压暗屏幕四周；低对比度的 300 像素扫描拖尾按参考效果约 6.8 秒循环，覆盖主页和打开的 session，且不绘制独立高亮线头。数字快捷键保留绿色荧光底和深色文字，不增加额外描边。

Agent 卡片使用全部剩余正文高度，以统一可读字号显示 Bottom Aligned 的实时 Terminal Tail，或紧凑的结构化 Chat Trail。Chat Trail 从清洗后的 Transcript 中展示最近可见 User Prompt、Agent Response 与当前 Activity，不重建或重排 ACP Entry。内容过多时裁剪，禁止压缩文字。只有 Live Pending / Running Agent 占据 Dashboard 机位；Stopped、Dead 与 Archived Record 离开实时 Grid，可恢复历史仍保留在 History。Terminal Card 仅在后端终端状态为 Working 时闪烁，Chat 使用克制的 Activity Signal。卡片和打开后的 Session 使用与 Farming Code 相同的 Agent 标题优先级，并始终保持单行省略。

### 6.1 按活跃度分级

| 等级 | 颜色 | 效果 |
|------|------|------|
| hot | #ff0000（红） | 强发光（多层 box-shadow），title bar 呼吸脉冲动画 |
| warm | #ff8800（橙） | 中等发光 |
| cool | #0088ff（蓝） | 弱发光 |
| cold | #004488（暗蓝） | 无发光，opacity 0.6，输出文字变暗 |

### 6.2 特殊状态

| 状态 | 效果 |
|------|------|
| zombie | opacity 闪烁动画（0.45-0.95），title bar 橙红色，ZOMBIE 文字 glitch 抖动 |
| stopped | 不进入实时 Grid；可恢复记录留在 History |
| dead | 不进入实时 Grid；可恢复记录留在 History |

### 6.3 设计约束

- 不使用整块亮色闪烁，避免刺眼
- opacity 动画的最低值不低于 0.4，保持可读性
- 闪烁周期 >= 2 秒，避免视觉疲劳

---

## 7. Agents Layout 核心原则

### 7.1 注意力驱动

用户的注意力是有限的。Agents layout 的首要目标是帮用户快速识别**哪些 agent 需要关注**，而不是平铺罗列所有信息。

### 7.2 面积即优先级

更需要关注的 agent 占据更大的面积，位于更显眼的位置。不需要关注的 agent 缩小退让。

### 7.3 排序

Agents layout 中的 agent 按 `attentionScore` 降序排列。最高分的 agent 排在第一位，占据最大面积。

---

## 8. 关键文件

| 文件 | 职责 |
|------|------|
| `src/components/TopBar.tsx` | 顶部状态栏组件 |
| `src/components/Sidebar.tsx` | 菜单组件 |
| `src/components/MapView.tsx` | Agents layout 排序、布局 class 选择、grid area 分配 |
| `src/components/AgentCard.tsx` | Agent 卡片组件（title bar + body） |
| `src/components/SessionModal.tsx` | Session 终端弹窗（顶栏 + 终端区 + 移动端输入条） |
| `src/components/InputDialog.tsx` | New Agent / Main Agent 启动对话框（agent 列表 + workspace） |
| `src/components/Settings.tsx` | Settings 对话框 |
| `src/App.tsx` | 页面整体 layout 组装 |
| `src/styles/main.css` | 布局样式 |
| `frontend/skins/crt/styles/effects.css` | CRT 专属视觉效果（静态扫描线与轻量扫描刷新） |
| `src/types/agent.ts` | Agent 类型定义（`attentionScore`、`isZombie`、`activityLevel`） |
| `src/components/MapView.tsx` | Agents Layout 的排序入口（按 `attentionScore`） |
| `src/App.tsx` | TopBar `Attn` 指示与最高关注 agent 选择 |
