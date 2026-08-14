# Farming Code 外观主题

> English version: [appearance-themes.md](./appearance-themes.md)

Farming Code 支持跟随系统、浅色、深色和纸张四种外观。外观只属于展示偏好；
切换外观不得改变 Agent、Session、Project、文件或终端状态。

## 设计契约

- 浅色是中性、高辨识度的默认外观。
- 深色用于低光环境。
- 纸张是适合长时间阅读的显式浅色方案。工作台画布、框架、阅读面、Composer、
  编辑器和终端共享同一个暖白纸面底色；层级主要由间距、细边框和克制的中性覆盖
  建立，而不是使用多档黄色表面。深色墨水文字提供对比；普通交互只使用墨色和中性
  色块，不使用焦点外圈或选中描边。绿色只保留给成功状态、数据可视化等确实承载语义
  的场景，其他状态色也继续保持自身语义。
- 纸张使用纯色层次，而不是纹理滤镜。重复颗粒或全局透明效果会降低代码可读性，
  不属于该主题。
- Paper 文件 Tab 的未选中标签与图标在 Tab Strip 纸面上共用同一个 Muted 墨色；选中
  标签与图标一起使用 Strong 墨色，并且只有当前 Tab 背后使用一块克制的色调填充。
- Paper 图标按钮静止时直接使用父级纸面；只有 Selected 或 Pressed Toggle 持续使用更深的
  Selected 填充，Hover 填充只提供临时反馈，未选中的静止按钮不使用局部底色。
- 桌面常驻导航使用 chrome 角色；紧凑布局的固定顶栏和导航抽屉使用 panel-surface
  角色，其中的 Project、Agent、Files Sticky 区域继承同一个表面。raised 只用于脱离
  普通文档流的浮层。静止控件继承结构性父级，不能再用 canvas 或 raised 背景替换父级表面。
- 当前 Agent 只使用一块 selected 填充，并完整包住前置 Provider 身份图标；Files 等未选中的
  Section Header 保持 panel 表面，不能表现得像第二个选中项。
- 同一 Active 项在不同位置的表示使用相同的 Selected 填充，例如当前文件行必须与对应的
  Editor Tab 保持一致。Selected 或 Active 行不得增加左侧线、色条、边框或轨道，同一项也
  不得叠加多个相互竞争的选中提示。
- 视觉上连续的控件或状态表面，其基础层、Hover 或 Selected 填充层、覆盖层与操作层应保持
  同一套外轮廓圆角。方角与圆角的不对称组合只能来自明确的组合控件设计，不能由图层覆盖
  意外产生。
- 导航子组件统一消费继承的 `--code-navigation-surface`，由 Workspace 为不同布局映射这一
  局部角色；响应式组件规则可以改变几何布局，但不能自行选择另一档主题表面。
- 工作台区域应保持可辨识，但不能变成割裂的色块。Paper 的面板和组合控件使用一档
  轻微的中性色块，而不使用装饰性描边、焦点外圈或选中边界；文字、光标、背景和交互
  状态已经提供足够反馈。语义状态色仍可在内容内部使用。主题颜色应按语义角色选择，
  不能靠零散替换十六进制颜色来维护。

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
Composer、Files、Settings、Transcript、Review 和扩展前端等领域样式只拥有布局与
交互选择器；它们只能消费语义颜色角色，不能包含外观选择器或写死的 Code 颜色。

共享角色数量必须保持克制。普通角色只描述层级、内容、交互或功能语义，例如 canvas、
chrome、surface、raised、inset、hover、selected、disabled、文字层级、边框层级、
focus、accent、success、warning、danger、diff、shadow、editor 和 terminal。只有颜色
区分本身承载产品含义的视觉才允许显式色板例外，例如语法、数据图表、协作身份、Git
引用、品牌图像和 Farming Pet 美术。例外必须使用稳定语义命名，不能出现由选择器机械
拼接或带哈希后缀的名称。不随外观变化的固定美术色必须集中成一组小型、具名的组件
调色板；外围文字、框架、边框、焦点，以及由透明度或阴影形成的派生效果仍必须消费
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
- 主文字与弱化文字可读，焦点清晰，成功、警告、危险和 diff 状态可以区分。
- 桌面与紧凑布局都不出现未覆盖的纯白或深色区域。
