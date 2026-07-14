# 移动端布局设计

> English version: [mobile_layout.md](./mobile_layout.md)

本文档描述 CRT 皮肤移动端（`max-width: 980px`）的平台特有布局。通用设计见 `base_layout.zh_cn.md`。

---

## 1. 整体页面结构

```
┌───────────────────────┬─────┐
│        TopBar         │     │
├───────────────────────┤[=]  │
│                       │[N]  │
│                       │[L]  │
│    Agents Layout      │[H]  │
│                       │[K]  │
│                       │[$]  │
│                       │[S]  │
├───────────────────────┴─────┤
│ [M]  [___输入框___]    [⏎]  │
└─────────────────────────────┘
```

- 最外层 `.app-container` 为纵向 flex（column）。
- TopBar 在最上方，`flex-shrink: 0`。
- `.main-content` 为横向 flex（row），`flex: 1`，包含 Agents Layout 和右侧菜单窄条。
- 底部 Main Agent 输入条在 `.main-content` 之外，`flex-shrink: 0`。

---

## 2. TopBar

### 2.1 与桌面端的差异

- 隐藏 Attn 项（`display: none`），节省横向空间
- 更紧凑：`padding: 6px 10px`
- 横向可滚动（`overflow-x: auto`），防止窄屏截断
- `≤640px` 时进一步缩小 `font-size` 和 item padding

### 2.2 设计原则

- 尽量薄，为 agents layout 区域让出垂直空间
- 信息密度不降低，仅缩小字号

### 2.3 模态对话框（New Agent / Settings）

- 自底部滑上的 sheet（`.dialog-overlay` + `.input-dialog` / `.settings-dialog`），顶栏与选项列表的克制规格与桌面同源，见 `base_layout.zh_cn.md` §5.4。
- **Workspace 路径输入**：保持 **`font-size: 16px`** 与足够 **`min-height`**，避免 iOS 聚焦缩放页面；与 ghostty 画布 **10px**、底部 Main 输入条 **16px** 策略一致。

---

## 3. Sidebar → 右侧菜单窄条

### 3.1 定位与尺寸

- 固定宽度 `38px`，纵向排列
- 背景色使用 `--theme-panel-strong-bg`
- 左边框 1px，与 agents layout 分隔
- 内部 padding `4px 3px`

### 3.2 结构

收起状态（默认）：

```
┌────┐
│[=] │  ← toggle 按钮
│[N] │
│[L] │
│[H] │
│[K] │
│[$] │
│[S] │
└────┘
```

展开状态（点击 toggle 后，宽度 160px）：

```
┌─────────────────┐
│[×]              │  ← toggle 按钮
│[N] New Agent    │
│[L] Task List    │
│[H] History      │
│[E] Extensions   │
│[$] Billing      │
│[S] Settings     │
└─────────────────┘
```

### 3.3 Toggle 按钮

- 位于菜单顶部，样式与菜单项一致（同边框、背景、字体）
- 收起时显示 `[=]`，展开后显示 `[×]`
- 收起时约 **`28x28px`**，展开后宽度随 sidebar 自适应，高度保持 **28px**
- 点击切换 sidebar 收起/展开状态

### 3.4 菜单项

- 每项约 **`28x28px`** 方块，`font-size: 11px`
- 收起时只显示快捷键字母（如 `[N]`），label 文字通过 `.sidebar-item-label { display: none }` 隐藏
- 展开时显示完整 label，宽度自适应，高度保持 **28px**
- 间距 `gap: 3px`
- enabled / disabled 状态与桌面端一致
- 桌面端的 Main Agent 面板（`.main-agent-panel`）在移动端 `display: none` 隐藏

### 3.5 设计原则

- **紧凑但可触控**：**28px** 方块略小于桌面菜单高，仍保留可点面积
- **与底部栏对齐**：sidebar 宽度 38px 与底部输入条右侧按钮（32px + 4px padding）视觉对齐

---

## 4. Agents Layout

### 4.1 纵向排列

移动端屏幕窄，不使用桌面端的 Grid 分屏布局，改为**纵向单列排列**（vertical stack）：

```
┌─────────────────────┐
│  agent-0 (score:85) │  ← 高分，卡片更高
│                     │
│                     │
├─────────────────────┤
│  agent-1 (score:60) │  ← 中分
│                     │
├─────────────────────┤
│  agent-2 (score:30) │  ← 低分，卡片紧凑
├─────────────────────┤
│  agent-3 (score:10) │
└─────────────────────┘
```

### 4.2 排序

按 `attentionScore` 降序，从上到下排列。最需要关注的 agent 在最顶部。

### 4.3 面积映射

与桌面端"面积即优先级"原则一致，但纵向体现为**高度**：

- 高分 agent（如 hot/warm）卡片高度更大，显示更多输出预览内容
- 低分 agent（如 cold）卡片紧凑，只显示 title bar 和少量预览
- 具体高度由 attentionScore 区间决定

### 4.4 滚动

- agents layout 区域可纵向滚动
- 首屏优先展示高分 agent

---

## 5. Main Agent 底部输入条

### 5.1 定位与尺寸

- 固定在页面最底部，全宽，`flex-shrink: 0`
- 桌面端 `display: none`，移动端 `display: flex`
- `padding: 3px 4px`，底部含 `env(safe-area-inset-bottom)` 适配刘海屏
- 内部元素间距 `gap: 4px`

### 5.2 结构

从左到右：

| 元素 | 尺寸 | 说明 |
|------|------|------|
| M 图标 | `32x32px` | 红色边框按钮，大写字母 M（`font-size: 18px`），点击打开 main agent 的 session 弹窗 |
| 输入框 | `flex: 1`，高 `32px` | 红色边框，`font-size: 16px`（防止 iOS 缩放），placeholder 半透明红色 |
| 回车图标 | `32x32px` | 红色边框按钮，⏎ 符号（`font-size: 18px`），点击后发送输入到 main agent 并打开 session 弹窗 |

### 5.3 交互逻辑

- **点击 M 图标**：直接打开 main agent 的 session 弹窗
- **输入文字 + 点回车图标（或按 Enter）**：将输入内容发送到 main agent（追加 `\r`），清空输入框，然后打开 session 弹窗
- **无 main agent 时**：整个组件不渲染

### 5.4 视觉风格

- 红色主题（`--theme-border-error` / `--theme-error`），与桌面端 Main Agent 面板一致
- 顶部 1px 红色边框
- 按钮 `font-size: 18px`，`font-weight: bold`

### 5.5 设计原则

- **一键直达**：M 图标是进入 main agent 终端的最快路径
- **快速输入**：不需要打开 session 弹窗就能发送简短指令
- **视觉对齐**：按钮尺寸 32px 配合 padding 4px，右边缘与上方 sidebar（38px）对齐

### 5.6 Session 弹窗内的 ghostty 终端

- 与桌面共用同一套 session 终端池；在 **`max-width: 980px`** 下新建会话时，画布字号为 **`10px`**，桌面新建为 **`11px`**（见 `base_layout.zh_cn.md` §5.3、`src/lib/ghostty.ts`）。
- Session 底部 **`mobile-terminal-input`** 仍保持 **`font-size: 16px`**（见 §5.2），避免 iOS 输入聚焦自动缩放整页；仅画布（canvas）使用较小字号。

---

## 6. 被否决的方案

### 6.1 菜单横排在底部输入条上方

曾尝试将菜单项移到底部、横排在输入条上方（类似 toolbar），视觉效果不佳，已否决。保持右侧竖排窄条。

---

## 7. 关键文件

| 文件 | 职责 |
|------|------|
| `src/components/TopBar.tsx` | 顶部状态栏组件 |
| `src/components/Sidebar.tsx` | 菜单组件（移动端只显示快捷键字母，含 toggle 展开） |
| `src/components/MobileMainAgentBar.tsx` | 移动端 Main Agent 底部输入条 |
| `src/components/InputDialog.tsx` | New Agent / Main Agent 启动对话框 |
| `src/components/Settings.tsx` | Settings 对话框 |
| `src/components/MapView.tsx` | Agents layout 渲染（移动端纵向排列） |
| `src/App.tsx` | 页面整体 layout 组装 |
| `src/styles/main.css` | 布局样式（`@media (max-width: 980px)` 和 `@media (max-width: 640px)` 断点） |
