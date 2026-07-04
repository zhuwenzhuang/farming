# 桌面端布局设计

> English version: [pc_layout.md](./pc_layout.md)

本文档描述 CRT 皮肤桌面端（`min-width: 981px`）的平台特有布局。通用设计见 `base_layout.zh_cn.md`。

---

## 1. 整体页面结构

```
┌─────────────────────────────────────────────┐
│                  TopBar                     │
├──────────────────────────────┬──────────────┤
│                              │              │
│       Agents Layout          │   Sidebar    │
│                              │  （右侧栏）  │
│                              │              │
└──────────────────────────────┴──────────────┘
```

- 最外层 `.app-container` 为纵向 flex（column），TopBar 在最上方，`flex-shrink: 0`。
- `.main-content` 为横向 flex（row），`flex: 1`，填满剩余高度。
- Agents Layout 占据 main-content 剩余宽度（flex: 1），Sidebar 固定宽度在右侧。

---

## 2. TopBar

- `padding: 4px 15px`
- `font-size: 12px`
- 背景色 `--theme-panel-strong-bg`，下方 1px 边框
- 各项通过 `padding: 2px 8px` 留出间距
- 显示全部项（含 Attn）

---

## 3. Sidebar

### 3.1 定位与尺寸

- 固定宽度 `200px`，`flex-shrink: 0`
- 背景色 `--theme-panel-strong-bg`
- 左边框 1px，与 agents layout 分隔
- 内部 padding `15px`
- 纵向 flex 布局，菜单列表在上方（`flex: 1`），Main Agent 面板在下方

### 3.2 结构

```
┌──────────────┐
│ [N] New Agent│
│ [L] Task List│
│ [H] History  │
│ [K] Skills   │
│ [$] Billing  │
│ [S] Settings │
├──────────────┤
│ MAIN AGENT[0]│  ← Main Agent 面板标题
│ ┌──────────┐ │
│ │ 终端预览  │ │  ← 嵌入 AgentCard（compact 模式）
│ └──────────┘ │
└──────────────┘
```

### 3.3 菜单项样式

- 左侧快捷键提示用 cyan 色（`--theme-info`），固定宽度约 `24px`，`font-size: 10px`
- 每项 `min-height: 32px`，`padding: 5px 8px`，`margin: 2px 0`，主文案 `font-size: 11px`
- 带 1px 边框的卡片样式（`fx-crt-panel-compact`）

### 3.4 Main Agent 面板

- 位于菜单列表下方，`flex-shrink: 0`
- 内容区嵌入一个 compact + hideTitle 的 AgentCard，`max-height: 120px`，溢出隐藏

### 3.5 New Agent / Settings 对话框

从 Sidebar **N**、**S** 打开的模态框（`InputDialog`、`Settings`）与 Session 弹窗同一气质：细软边框、扁顶栏、11px 级排版；完整规格见 `base_layout.zh_cn.md` §5.4。

---

## 4. Agents Layout

### 4.1 终端分屏风格

卡片之间没有空白间隔，用 1px 细线分隔，像终端或编辑器分屏。整个区域被完全利用，不留空白。

间隔线颜色为深灰（`#111`），不使用亮色以避免 opacity 变化时透出刺眼颜色。

### 4.2 Grid 模板

根据 agent 数量选择不同的 CSS Grid 模板（以 `grid-template-areas` 定义）：

**1 个 agent** — 铺满整个区域：
```
┌──────────────┐
│      a0      │
└──────────────┘
```

**2 个 agent** — 左大右小（7:3）：
```
┌──────────┬───┐
│    a0    │a1 │
└──────────┴───┘
```

**3 个 agent** — 左边占满高度，右边上下两个：
```
┌────────┬─────┐
│        │ a1  │
│   a0   ├─────┤
│        │ a2  │
└────────┴─────┘
```
列比 6:4。

**4 个 agent** — 2x2，左上更大：
```
┌────────┬─────┐
│   a0   │ a1  │
├────────┼─────┤
│   a2   │ a3  │
└────────┴─────┘
```
列比 6:4，行比 6:4。

**5+ 个 agent** — 左上大块 + 右列 + 下行：
```
┌──────┬────┬────┐
│      │ a1 │ a2 │
│  a0  ├────┼────┤
│      │ a3 │ a4 │
└──────┴────┴────┘
```
列比 5:2.5:2.5，行比 6:4。超过 5 个的 agent 以紧凑模式自动流入。

### 4.3 Session 终端弹窗

桌面端打开 agent 终端时，`SessionModal` 采用 **比地图卡片更克制** 的顶栏与外壳（见 `base_layout.zh_cn.md` §5.3）：`4px 8px` 顶栏、细 **1px** 柔和边框（`--theme-border-soft`）、无外壳 CRT 外发光；Kill/Close 更小一号，避免对话框式厚重感。交互终端（ghostty）画布默认 **`11px`**，与全局 CRT 小字号一致。

---

## 5. 关键文件

| 文件 | 职责 |
|------|------|
| `src/components/TopBar.tsx` | 顶部状态栏 |
| `src/components/Sidebar.tsx` | 右侧边栏（菜单 + Main Agent 面板） |
| `src/components/InputDialog.tsx` | New Agent / Main Agent 启动对话框 |
| `src/components/Settings.tsx` | Settings 对话框 |
| `src/components/MapView.tsx` | Agents layout Grid 模板选择与渲染 |
| `src/components/AgentCard.tsx` | Agent 卡片（Sidebar 中以 compact 模式复用） |
| `src/components/SessionModal.tsx` | Session 终端弹窗 |
| `src/App.tsx` | 页面整体 layout 组装 |
| `src/styles/main.css` | 布局样式（`.top-bar`、`.sidebar`、`.map-area` 等） |
