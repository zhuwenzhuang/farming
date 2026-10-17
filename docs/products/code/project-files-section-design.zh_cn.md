# Project Files 设计

> English version: [project-files-section-design.md](./project-files-section-design.md)

Files 服务于监督 Agent 时的查看和轻量编辑，不是第二个 IDE。本篇负责产品边界；
[Workspace File 状态模型](workspace-file-state-model.zh_cn.md)负责版本、工作副本一致性及
变更恢复，[Workspace 传输协议](workspace-transport-protocol.zh_cn.md)负责投递、取消和大内容限制。

## 所有权与布局

| 所有者 | 职责 |
| --- | --- |
| Project 组合层 | 持久 workspace membership、Agent、Open Editors、Files、Changes 与 History；一个侧栏滚动面 |
| Explorer | 展开、焦点、选择、键盘导航和有界行投影 |
| Workspace 后端 | 已授权规范路径、文件系统/Git 事实、版本、有界读取与变更核对 |
| Editor 与 Viewer | 草稿、标签、阅读位置、冲突和有界预览 |

最后一个 Agent/编辑器关闭不移除 Project。显式移除按顺序核对依赖：归档 Agent、移除主界面
Session membership、关闭编辑器、卸载 Project。失败停止后续步骤并保留 membership；
重试重新读取现状，不回滚已完成清理，也不盲目重放未知结果。

创建 Agent 和发现新 workspace 在报告成功前建立 membership。同一未挂载 Project 的并发
发现共享一次挂载；已挂载 Project 内打开文件不重新挂载。用户明确选择的仓库子目录保持
Project 边界，即使 Git 操作属于外层 worktree。Git 拥有 worktree，Farming 只拥有其挂载与顺序。

## 身份与导航

文件身份由规范 workspace 和相对路径决定，与选中 Agent 无关。来源 Agent 只是导航关联，
不拥有文件。URI 边界只编码/解码一次；自由终端文本不能把任意空格解释成路径组成部分。

所有绝对文件入口复用后端 worktree 解析。已证明所属 worktree 时走普通 Project 路径；
仓库外文件走有界只读全局访问，不伪造 Explorer 目标。桌面 Reveal 需要权威本地后端能力，
不能从主机名猜测。

跨 Project 的文件打开入口共享一个导航意图。同一待打开文件共享读取，合并最新查看意图，
固定标签只能增强；更新的不同文件意图使旧意图失效。只有当前意图能提交主面板、焦点和
视图挂载。迟到结果可更新数据，不能覆盖更新的导航。

选择、键盘焦点和活动编辑器身份独立。Explorer 只拥有一个选择面，活动文件不能再涂第二行。
Reveal 只导航，不重新打开文件或改变草稿。更新的 reveal 或直接用户交互撤销旧滚动操作。
恢复视图记忆必须在权威 Project/Agent 恢复后进行，忽略失效目标。

目录读取有 absent/loading/loaded/failed 状态，并按 workspace 代际隔离。展开由用户拥有，
迟到读取不能重新展开已折叠目录。Files 隐藏时不因恢复展开记录启动 I/O。单子目录链压缩
有深度边界，不自动跨符号链接。

## 工作副本与变更

文件系统是权威来源。工作副本保存 baseline、draft 和 revision，保存旧 revision 不能把新
草稿标为干净。干净文件接受权威外部更新；脏文件保留草稿并明确冲突。只 watch 已打开的确切
文件并触发有界重读，不引入递归 Project watcher。

保存/创建/重命名/移动/删除验证授权身份与预期版本；冲突由用户明确选择重载或覆盖。
未知变更从磁盘或目录状态核对，不自动重放。Farming 不声称与独立 Agent、shell、编辑器或
其他实例拥有跨客户端事务。具体状态机由上面的文件状态契约维护。

剪贴板操作绑定确切文件/model。Cut 只有确认写入剪贴板成功后才删文本；迟到完成不能修改
替换后的 model。菜单、对话框及异步能力读取在导航或关闭后失去发布权。

## 搜索与目录上下文

Project 搜索默认限定 Project，只有用户明确选择才缩小到目录。全局搜索只覆盖已挂载的
非 Main Project。结果保留 root 与相对路径，区分目录/文件和同名对象，显示有界数量、加载、
不完整及失败状态。目录名称匹配不自动返回所有后代；选中后不能改为全局文件系统或模糊替代。

改变 query/filter、关闭搜索或转向其他导航会使待打开请求失效。只有确切、当前、成功读取
才激活文件或目录；失败保持搜索可见。目录激活只展开已有树，不打开任意子文件、不挂载
Project，也不恢复 Agent。

Files 标题的祖先目录上下文来自可见树位置，不来自选择。它是稳定标题槽中的元信息，不是
重复的 sticky 目录行，不能改变几何、展开、搜索范围或滚动。搜索通过显式操作占用该槽，
hover 不切换模式。Escape 先关闭建议，再关闭搜索；IME 组合保留自己的 Escape 所有权。

搜索只有 Farming 固定版本原生 ripgrep 路径；枚举与匹配共用一个绝对期限，取消传递到
子进程。Artifact 缺失或无效时明确失败，不换另一搜索实现。目录结构独立于 Git/ignore
装饰加载，装饰失败不能阻塞导航。

## 编辑与预览边界

所有 Viewer 共享授权文件身份、版本和访问路径。Source/preview 切换保留同一工作副本和
逐文件阅读状态。干净预览标签可被替换，固定标签保持固定直到显式关闭。

2 MiB 以内文本完整可编辑；2–10 MiB 完整只读；更大文本只显示前 10 MiB 并明确截断。
大树与 Markdown 只挂载有界视口，不挂完整文档 DOM。宽度/主题变化保留阅读锚点。

Markdown 使用安全 GFM/math 与有界兼容，不改写源文件或执行任意 HTML。静态 HTML 复用
现有预览隔离；图片、PDF 和二进制只读。不支持或无效内容明确可见。语法诊断留在本地，
已保存文件的语义分析与导航归 [Language Server](language-server.zh_cn.md)；脏草稿不能把
旧磁盘版本语义结果呈现为当前事实。

表格预览是只读、带文件版本的 workbook 快照。加载/刷新拥有可取消 fetch 和 Worker parse，
限制字节、ZIP 展开和单元格预算；替换或关闭释放旧工作并拒绝迟到结果。显示格式化值及
公式缓存缺失警告，不重算、不执行宏或刷新外链。隐藏 sheet/行/列保持可发现。复制与 Chat
引用使用当前显示选择，并保留原 sheet、坐标和文件版本。

## Git 与 Review

Git 读取解析最近的已授权、已初始化仓库。Submodule 拥有自己的变更、index 和 Review
范围，父 gitlink 变更独立。仓库不可用或命令截断/失败不能代表干净；只读检查不写 Git index。

| 读取 | 一致性契约 |
| --- | --- |
| Changes | 每仓库/类别完整数量及不可变清单的有界分页，不用共享配额隐藏类别 |
| History | 捕获 HEAD、branch、tips 与 labels；续页遍历不可变 commit，不对实时 ref 使用 offset |
| Blame | 已保存文件的不可变快照；行内容必须匹配展示内容，包括 diff 的确切历史侧 |
| File Diff | 确切 model 对；按已计算差异导航，不能覆盖后来的用户输入 |
| Review | 拥有独立身份的范围化比较，见 [Review 基础](review-foundation.zh_cn.md) |

Cursor 绑定仓库、范围与快照。写入/watch 事件使相关清单（含正在捕获的）失效；过期、淘汰
或重启要求刷新，不能混页。并发读者可共享捕获，不能互相取消工作。过期读取有界恢复后
提供显式 Retry。脏草稿暂停磁盘 blame；过期读取不能发布。

创建 worktree 先读取新鲜的名称/来源预览，准入时重查可用性。持久请求 ID 绑定来源、命名
策略与起始 commit，重复请求加入原操作。默认名称可分配冲突后缀，自定义名称必须精确。
最小化/关闭观察不取消已准入 Git 工作。成功发布确切 Project，失败保留输入，未知结果只
核对原操作，不重放。

切换分支与打开其他 worktree 独立。切换要求最新证明：确切 main worktree 干净、目标是
未在其他 worktree 使用的现有本地分支、没有活动或状态不明的 Agent 工作。后端阻止新输入，
结算先前准入，再核对所有权、预期分支和 HEAD；不 fetch、stash、创建 tracking branch 或
强制覆盖。失败/未知结果先重读分支事实，再允许明确重试。

## 视觉与交互规则

复用 [UI 设计](../../development/ui-design-protocol.zh_cn.md)与
[交互](../../development/ui-interaction-protocol.zh_cn.md)的共享所有者。Files、Open Editors
和 Changes 共享几何与状态语言，同一语义不新增局部样式变体。

- 文件行桌面 24px、紧凑 28px、缩进步长 8px；紧凑 Project/Agent 导航仍为 44px。文件图标
  与目录箭头占同一前导槽，任何深度都保留可读名称。
- 一个 Project scroller 拥有实际位移，虚拟列表只选择挂载行，不增加第二滚动面或滚动位移
  补偿。Project 摘要层在末尾一起释放；密度变化保留逐行相对阅读位置。
- Open Editors 有界，滚动条出现不能移动名称和动作。Files 标题动作槽稳定，目录上下文
  不能形成几何反馈循环。
- 窄屏保持保存/source/冲突等主动作可达，次级动作进入共享菜单。触屏 source 保留原生
  选择/复制和同一工作副本、冲突规则。
- Paper 的标签、面包屑与编辑器连续，同一选择、菜单焦点、脏/错误状态在所有主题使用共享 token。

## 验收标准

覆盖空/多 Project、精确路径与符号链接、跨 Project 导航、重载及取消/过期读取，脏文件与
外部变化、未知写入，submodule、不可变 Git 分页和 worktree 竞态，大树/文件/预览及键盘/
触屏交互。生产形态场景限制请求时间、挂载行数与渲染工作，同时保持全部内容可达。
桌面与窄屏均覆盖 Light、Dark、Paper。
