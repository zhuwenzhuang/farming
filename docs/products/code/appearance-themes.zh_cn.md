# Farming Code 外观主题

> English version: [appearance-themes.md](./appearance-themes.md)

Farming Code 支持跟随系统、浅色、深色和纸张四种外观。外观只属于展示偏好；
切换外观不得改变 Agent、Session、Project、文件或终端状态。

[UI 设计协议](../../development/ui-design-protocol.zh_cn.md)约束公共控件家族、字排、几何、
图标、响应式行为和跨页面等价性。本文档拥有它们的外观角色与主题生命周期。

## 设计契约

- 浅色是中性、高辨识度的默认外观。
- 深色用于低光环境。
- 纸张是适合长时间阅读的显式浅色方案。工作台画布、框架、阅读面、Composer、
  编辑器和终端共享同一个暖白纸面底色；层级主要由间距、细边框和克制的中性覆盖
  建立，而不是使用多档黄色表面。深色墨水文字提供对比；鼠标 Hover 和 Selected 使用
  墨色与中性色块，不增加装饰性描边；非文本控件可使用克制但清晰可见的墨色键盘焦点环。
  绿色只保留给成功状态、数据可视化等确实承载语义的场景，其他状态色也继续保持自身语义。
- 纸张使用纯色层次，而不是纹理滤镜。重复颗粒或全局透明效果会降低代码可读性，
  不属于该主题。
- Paper 文件 Tab 的未选中标签使用 Muted 墨色，选中标签使用 Strong 墨色，并且只有当前
  Tab 背后使用一块克制的色调填充。文件类型、Provider 与语义状态图标在文件树、Open
  Editors、Tab、面包屑和 Chat 中保留各自的身份颜色；普通导航与操作图标继续使用中性
  文字层级。
- Paper 图标按钮静止时直接使用父级纸面；只有 Selected 或 Pressed Toggle 持续使用更深的
  Selected 填充，Hover 填充只提供临时反馈，未选中的静止按钮不使用局部底色。
- 桌面常驻导航使用 chrome 角色；紧凑布局的固定顶栏和导航抽屉使用 panel-surface
  角色，其中的 Project、Agent、Files Sticky 区域继承同一个表面。raised 只用于脱离
  普通文档流的浮层。静止控件继承结构性父级，不能再用 canvas 或 raised 背景替换父级表面。
- 当前 Agent 只使用一块 selected 填充，并完整包住前置 Provider 身份图标；Files 等未选中的
  Section Header 保持 panel 表面，不能表现得像第二个选中项。
- Selected 或 Active 行不得增加左侧线、色条、边框或轨道，同一项也不得叠加多个相互竞争的
  选中提示。Active Agent 行和文件行使用不透明的 `--code-active-item-surface` 角色，使它们
  跨不同父级表面时最终渲染颜色仍保持一致，同时不改变其他控件使用的通用
  `--code-bg-selected` 角色。Light 与 Paper 的 Active Item 表面保持中性，不使用强调蓝填充。
  Editor Tab 使用与文档连贯的 `--code-file-editor-active-tab-surface`：Light 与 Dark 的
  Active Tab 连接编辑器画布，Paper 则保留克制的中性填充。同一组 Project、Agent、文件或
  Editor Tab 的鼠标 Hover 与 Selected 使用相同表面，不再引入第二种 Hover 填充色。
- 视觉上连续的控件或状态表面，其基础层、Hover 或 Selected 填充层、覆盖层与操作层应保持
  同一套外轮廓圆角。方角与圆角的不对称组合只能来自明确的组合控件设计，不能由图层覆盖
  意外产生。
- 常驻左侧导航在所有外观中都使用同一套中性 Surface 语言表达键盘焦点、鼠标 Hover 与
  Selection。Project、Agent、文件、Resource、菜单及侧边栏操作的焦点必须通过 Surface、
  文字、图标和操作入口保持可见，不得再叠加有色外框或焦点阴影。
- 所有外观的单行、多行文本输入框都通过文本光标表达编辑焦点，鼠标和键盘聚焦遵循
  同一规则。焦点不得给输入框或其容器增加外圈、阴影或强调色边框；普通控件边界和
  校验错误样式与焦点独立。需要额外键盘反馈的按钮及选择器只使用一道克制的边界，
  不叠加 Outline 和 Shadow。共享控件焦点阴影（包括 Model Matrix）只使用单层 1 像素
  焦点环，不用于文本输入框。
- 滚动容器不是导航项。点击空白处、拖动滚动条或为键盘滚动聚焦容器时，不得给整个
  容器涂上选中底色或添加焦点阴影；具体行仍保留 Hover、Selection 和键盘焦点反馈。
  相邻尺寸调节柄的命中区不得覆盖滚动条交互槽。
- Farming Code 原生滚动条统一使用 8 像素交互槽、4 像素圆角滑块和透明轨道，默认、Hover
  与 Active 状态均取自共享外观注册表。领域样式不得重新定义滚动条几何或颜色。Monaco 与
  Terminal 保留各自的渲染器接入方式，但必须映射到同一套几何和状态色。只有具备明确替代
  滚动交互的场景（例如水平 Editor Tab 条）才允许隐藏滚动条。
- 导航子组件统一消费继承的 `--code-navigation-surface`，由 Workspace 为不同布局映射这一
  局部角色；响应式组件规则可以改变几何布局，但不能自行选择另一档主题表面。
- Project、Agent、Files、Open Editors 和 Git History 共用这一导航底色，包括吸顶标题、
  行间缝隙、加载中、空状态、非 Git 仓库和错误提示。展开、聚焦或滚动集合不能给容器
  涂色。行的 Hover、Focus 和 Selected 使用相同的不透明 Active Item 表面；选中后再
  悬停不能叠加半透明填充，也不能把展开详情涂成另一块选中区域。
- 工作台区域应保持可辨识，但不能变成割裂的色块。Paper 的面板和组合控件使用一档
  轻微的中性色块，而不使用装饰性描边或选中边界。键盘焦点必须通过适合控件的文本
  光标、焦点环、背景或其他交互状态保持可见。语义状态色仍可在内容内部
  使用。主题颜色应按语义角色选择，不能靠零散替换十六进制颜色来维护。

## 状态模型

持久化的 UI 设置是外观偏好的权威来源。允许值为 `system`、`light`、`dark` 和
`paper`，无效值归一化为 `system`。跟随系统只根据 `prefers-color-scheme` 解析为
浅色或深色；纸张始终需要用户显式选择。

首次导航时，服务端把已保存偏好写进入口文档。内联启动代码会在应用 CSS 加载前
解析外观，让浏览器画布、主题色和 color scheme 避免出现高反差首帧。应用启动后，
根元素和 body 上的外观属性由应用维护。只有跟随系统偏好会响应操作系统颜色变化。

切换外观会同步更新文档属性、浏览器元数据、Monaco 主题和终端主题。设置写入失败时，
沿用现有设置回滚路径，不得让显示偏好与权威设置不一致。

## CSS 所有权

`shared/appearance-themes.json` 是外观的唯一权威注册表。每种已解析外观都必须定义
完全相同的一组 CSS 角色，以及浏览器元数据、Monaco、Terminal、终端搜索和 Mermaid
色板。注册表表达的是数据而不是组件选择器，因此新增外观必须一次性补齐完整清单，
不能再靠逐页覆盖完成。

`tokens.css` 由该注册表生成，只包含 Light、Dark、Paper 各一条规则，禁止手工修改。
共享控件 Recipe 拥有可复用的几何与交互样式。Composer、Files、Settings、Transcript、
Review 和扩展前端等领域样式拥有组合与领域布局，不能分叉共享 Recipe。两者都只能消费
语义颜色角色、保持外观中立，不能包含外观选择器或写死的 Code 颜色。

共享角色数量必须保持克制。普通角色只描述层级、内容、交互或功能语义，例如 canvas、
chrome、surface、raised、inset、hover、selected、disabled、文字层级、边框层级、
focus、accent、info、success、warning、danger、diff、shadow、editor 和 terminal。
只有颜色区分本身承载产品含义的视觉才允许显式色板例外，例如语法、数据图表、协作
身份、Git 引用、品牌图像和 Farming Pet 美术。例外必须使用稳定语义命名，不能出现由
选择器机械拼接或带哈希后缀的名称。不随外观变化的固定美术色必须集中成一组小型、
具名的组件调色板；外围文字、框架、边框、焦点，以及由透明度或阴影形成的派生效果仍必须消费
外观语义角色。静态契约目前只放行 Model Matrix 身份色和 Pet 黑洞预览调色板。

Farming CRT 的固定色板独立放在 `crt-tokens.css`。CRT 皮肤颜色不是 Code 外观角色，
不得再混入 Code 主题注册表。

不得重新增加 `<domain>-dark.css`、Paper 覆盖文件、选择器级色板 token，或在领域样式
中增加外观选择器。入口页首帧代码由同一注册表生成；服务端元数据和所有 JavaScript
颜色消费者直接读取该注册表。静态契约会拒绝主题字段缺失、生成文件过期、哈希 token、
Code 固定颜色，以及在生成文件之外按外观分支。

## 验收标准

- 每个选项都可选择，并能在刷新后保持。
- 纸张声明浅色浏览器 color scheme，并在应用启动前使用暖色画布。
- 导航、Chat、Composer、Settings、Files、Review、Browser/Computer 扩展、Monaco、
  Terminal 和 Mermaid 无需刷新即可重绘。
- 原生、Monaco 与 Terminal 滚动条在每种已解析外观中共享同一套几何以及默认、Hover、
  Active 状态色。
- 主文字与弱化文字可读，焦点清晰，成功、警告、危险和 diff 状态可以区分。
- 文本输入测试覆盖鼠标聚焦、Tab 导航、输入和取消，且不能出现焦点外圈；导航项和
  非文本控件保留各自可见的键盘反馈。Light、Dark、Paper 截图基线覆盖组合交互状态；
  颜色比例断言只能补充，不能替代截图基线比较。
- 桌面与紧凑布局都不出现未覆盖的纯白或深色区域。
