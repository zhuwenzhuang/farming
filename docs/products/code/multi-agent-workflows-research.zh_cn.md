# 多 Agent 工作流：业界证据与 Farming 取舍

> English version: [multi-agent-workflows-research.md](./multi-agent-workflows-research.md)

资料核对日期：2026-09-17。本文是产品调研与建议，不代表 Farming 已实现工作流编排。
交互设计见[关联会话与旁聊](related-sessions-design.zh_cn.md)。

## 结论

**图式 Agent 工程已经有明确的生产应用，其价值不只体现为“同一问题回答得更好”，还体现为业务流程可以可靠执行、跨轮次交接、并行处理、恢复状态和持续迭代。**
LinkedIn 招聘、Lyft 客服、Harvey 合同审查，以及 Uber 代码审查提供了比大规模编程实验更直接的产品证据。

需要分别看三个问题：

- **工作流图是否有价值？** 有。真实产品用它组织路由、依赖、状态、校验、人工介入及执行恢复。
- **多个 Agent 是否有价值？** 有。明确分工、独立上下文和结果合并已经用于生产；Harvey 还公开比较了固定流水线、单 Agent 与主管／子 Agent 三种架构。
- **任意任务增加 Agent 或画成图都会更好吗？** 没有这种保证。图可以包含程序、模型调用、Agent、人工步骤，而不是每个节点都扮演一个人格角色。

对于产品决策，已部署、持续使用和可观察业务结果是有效证据。缺少等预算单 Agent 消融实验，限制的是对收益原因的精确归因，**不能被解释成产品没有实际价值**。
同时，使用 LangGraph 不等于用户需要手工拖拽节点；但 Harvey 的自定义工作流采用情况也说明，可复用业务流程的构建需求是真实存在的。

Farming 值得支持工作流的监督与执行证据，而不应把能力边界停在子会话列表。可优先验证代码审查流水线、动态故障调查图和批量工程任务；通用可视化编排的范围则应由这些场景验证。

## 证据分级

“生产”表示来源报告已用于实际工作，不表示经过独立审计。
厂商内部评测、客户案例和开放工程实验不能互相替代，也不能把自动化相对人工的收益等同于多 Agent 相对单 Agent 的增益。
本调研选择能说明任务、组织方式和结果的公开材料，并非全行业穷尽排名。
来源包含产品团队自己的技术文章、具名工程师分享、具名客户案例、框架厂商案例及基准论文。
Uber 原站直接读取受限，正文通过公开文本镜像获取；其来源仍引用 Uber 原文，不把镜像抓取时间当作发布日期。

| 场景与案例 | 工作如何拆分 | 来源报告的结果 | 能证明什么／不能证明什么 |
| --- | --- | --- | --- |
| LinkedIn Hiring Assistant：招聘 [9][10] | Supervisor 协调搜索、候选人评估与触达；异步后台任务、记忆、人类确认；明确使用 LangGraph | 早期客户每岗位节省超过 4 小时，达到候选短名单前少看 62% 档案，InMail 接受率提升 69% | LinkedIn 一手产品与架构文章；客户试用结果，不是图引擎单变量实验 |
| Lyft AI Assist：司机／乘客客服 [11] | 有状态路由→意图子图→专业子图，支持会话中交接；DynamoDB Checkpoint | 数百万次交互；首个司机 Agent 约 6 个月，新可配置 Agent 约 2 周；报告 AI 解决率提升 16% | Lyft 工程师具名文章；平台综合收益，16% 未明确为百分点；不同复杂度 Agent 的开发周期并非同任务对照 |
| Harvey Playbook Review：合同审查 [12] | 主管分配规则，最多数十个子 Agent 各自在文档分支上审查，合并冲突、最终验证、持久状态 | 相对旧流程：风险分类 59%→77%，修订 Rubric 53%→87%，平均延迟 2.6→3.8 分钟 | 一手技术文章，直接比较三种架构；数字来自内部评测，新系统质量更好但比旧流水线慢 |
| Uber uReview：代码审查 [13] | 按功能／规范／安全生成候选评论，再评分过滤、去重、分类与发布 | 覆盖 6 个 Monorepo；中位反馈 4 分钟；用户反馈有用率约 75%，自动判定约 65% 评论在同次修改中被处理 | 一手生产报告；属于多阶段专业模型工作流，不能据此称为自由协作 Agent 群 |
| Monte Carlo：数据故障调查 [14] | 告警触发动态调查图，节点按发现继续派生，检查变更／时间线／依赖 | 来源描述可启动数百子 Agent 检查根因假设，四周内完成面向客户的演示准备 | 明确的图式实现案例；文中仍在建设根因验证，不能声称已证明 MTTR 改善倍率 |
| Replit Agent：应用开发 [15] | 管理、编辑、验证等独立 Agent，跨数百步骤和多轮用户干预 | 已发布开发产品；复杂并行流程促使追踪系统增加长 Trace 搜索和多轮 Thread 聚合 | 已有真实产品，证明编排与监督需求；未给出架构导致的开发提速比例 |
| Anthropic Research：跨公司、跨来源研究 [1] | 主 Agent 分解调查，子 Agent 并行检索并返回压缩结果，主 Agent 汇总 | Opus 4 主 Agent＋Sonnet 4 子 Agent 在内部研究评测中，相对单 Opus 4 提升 90.2% | 已上线产品＋内部评测；不是提升 90.2 个百分点，也不是等成本对照；收益含更多推理投入 |
| Trellix Sidekick：日志解析器、第三方集成代码 [2] | 小子图先独立工作，再组合为大图；使用 Send API 的 map-reduce，工程师可介入 | 日志解析从数天到数分钟；插件开发从数天到一个下午的大部分时间 | 真实专业服务团队应用，来源为框架厂商客户案例；未披露样本量、错误率和对单 Agent 的对照 |
| Vodafone：运维数据调查与报告 [3] | 意图路由→文档检索或 NL2SQL→查询执行→结果分析／可视化，模块作为子图 | 两个内部助手部署在 Google Cloud，供数据中心工程师使用，报告缩短获取洞察时间 | 明确的实际用户和多 Agent 架构；没有公开量化提效比例或消融实验 |
| C.H. Robinson：邮件到运输订单 [4] | 邮件理解、分类、补齐信息、维护订单状态、创建订单 | 约 5,500 单／日自动处理，报告节省超过 600 小时／日 | 强业务规模证据，支持有状态工作流的价值；未证明同任务增加 Agent 数量产生了这些收益 |
| Anthropic C 编译器实验 [5] | 16 个 Agent 分担失败测试、目标项目与工程角色；通过 GCC 对照拆分内核问题 | 近 2,000 次会话，API 成本约 2 万美元，产出约 10 万行编译器，可构建 Linux 6.9 | 可检查的公开工程产物，不是成熟生产编译器，也没有等预算单 Agent 对照 |
| Cursor 长时工程实验 [6] | Planner 创建任务，Worker 执行，Judge 决定继续；规划也可递归拆分 | 浏览器实验约一周、超百万行；Solid→React 迁移超过三周，通过 CI 与初步检查但仍待仔细 Review | 显示大规模协调的可行性；代码量、提交量和 CI 通过不等于已交付质量或 ROI |

## 生产案例：图具体解决了什么

### LinkedIn：招聘不是一次搜索，而是持续推进的任务

[9] 描述的流程包括澄清职位、搜索、评估、触达与后续调整。Supervisor 同时协调交互式请求和异步后台执行；搜索和评估会随着反馈继续进行，而不是一次 Prompt 结束。
[10] 明确说明系统建立在 LangGraph 上，并给出早期客户每岗位节省 4 小时以上等结果。

图的价值是保持流程上下文、交接控制权、区分后台执行和人的决策点。架构文章还说明子 Agent 被作为工具建模，不给每个 Agent 都创建独立身份和邮箱。
**这证明复杂编排有用，也证明“一个工作节点必须对应一个独立聊天窗口”并不成立。**

### Lyft：可交接、可恢复的专业客服网络

[11] 给出真实实现：Meta Agent 用 `Command(goto=...)` 选择子图；意图子 Agent 可以返回父图，转给损失索赔等专家；乘客和司机采用不同 Router。
DynamoDB 保存完整图状态、执行元数据和父 Checkpoint 引用。每个专业子图共用安全、工具和状态基础设施，业务专家用 Prompt 和配置增加覆盖场景。

这里图的作用是让不同业务流程组合起来、会话中途换题仍能交接，并在进程／请求之外保留状态。
生产 Agent 都有在线评估，平台报告幻觉和矛盾率下降 20%、AI 解决率提升 16%。这些是平台综合效果，不是单独节点数量的效果。
源码片段和运行状态细节使它比只说“用了多 Agent”的营销案例更具体。

### Harvey：多 Agent 降低单 Agent 高质量审查的等待

[12] 的比较尤其关键：

| 架构 | 质量 | 延迟 | 为什么调整 |
| --- | --- | --- | --- |
| 固定 Prompt 流水线 | 中等 | 好 | 分类、引用和改写阶段丢失上下文，规则之间会产生冲突 |
| 单 Agent 审查 | 好 | 不可接受 | 能持续读文档、找条款、编辑，但串行处理太慢 |
| 主管＋规则子 Agent | 好 | 可用 | 并行处理规则，主管协调结果并完成最终验证 |

每个规则子 Agent 在自己的版本化文档分支上修改，输出带规则归属的修订和简短备忘录。
不冲突的改动直接合并，同一文本上的冲突交给主管处理。所有 Agent 共享当事方、合同来源和谈判偏好等必要背景。
状态随审查持久化，用户追问或改立场时复用相关工作，而不是从头跑整张图。

相对旧流水线，风险分类提高 **18 个百分点**、修订评分提高 **34 个百分点**；平均延迟从 2.6 到 3.8 分钟。
这些数字不是相对单 Agent 的提速；文章只定性报告单 Agent 延迟不可接受。
其优化目标是在可接受等待内提供更高质量，而非每个指标都优于旧系统。

这直接支持“并行分工＋隔离工作产物＋冲突合并＋最终验证”作为有效工程模式。
另外，Harvey 报告客户已创建超过 25,000 个自定义工作流 [16]。这是创建量，不是活跃运行量。
GSK Stockmann 客户案例 [17] 给出结构化尽调初期节省 15–20% 时间、非结构化资料室最高 75%；不能把最高值概括成所有法律工作的普遍收益。

### Uber：代码审查是比全自动写产品更成熟的工程流程

[13] 的标准、最佳实践和 AppSec 助手各自产出评论，后续阶段验证、过滤、去重并选择值得发给开发者的内容。
系统已覆盖六个代码库，反馈中位耗时 4 分钟，有用率约 75%。约 65% 的“被处理”比例来自自动复查判定，不等同于人工确认的缺陷修复率。

这个案例的关键在于流水线会主动丢弃低价值产物，而不是把所有子 Agent 的意见都展示给用户。
每条评论保存来源、分类、置信度及开发者反馈，再用这些数据改进专业阶段。
原文对 65,000 diffs 的周期同时存在每周／每月表述，因此这里不采用该规模数字。

它没有证明 LangGraph 是必要选型，也没有证明每个阶段都是自主 Agent，但清楚证明“分工→验证→汇总→反馈”在真实编码产品中有效。

### Monte Carlo 与 Replit：为什么用户需要看到执行结构

Monte Carlo [14] 的调查不是预先写死的长链，而是从告警出发，沿变更、时间、依赖派生多个根因分支；工具和证据足够时，图才有实质内容。
对 SQL、数据管线和性能诊断，这比简单安排“分析师 A→分析师 B”更贴切。案例没有提供已验证的根因准确率或 MTTR 倍率，应把架构证据与效果证据分开。

Replit [15] 已有管理、编辑、验证 Agent 和数百执行步骤。实际痛点是长 Trace 中定位失败，以及把多轮用户交互与后台执行关联起来。
这支持 Farming 提供工作节点、产物、耗时、失败位置和可介入点，而不仅显示 Agent 名字和聊天内容。

补充边界：[18] 的 LinkedIn QA Agent 报告发现超过 200 个有效 Bug，包含规划、执行和多阶段错误验证。
它是实际 Agent 工程证据，但不能因为存在多个模型／处理阶段就宣称它是多个独立自主 Agent 的对照成功案例。

## 可复用的图模式

| 模式 | 代表案例 | 用户真正需要的能力 |
| --- | --- | --- |
| 有状态路由与交接 | Lyft、LinkedIn | 知道当前处理者、已收集信息、下一步和需人决定的事项 |
| 并行分支与汇合 | Harvey、Anthropic Research | 分支进度、部分结果、失败分支隔离、合并冲突及最终验收 |
| 动态调查树／图 | Monte Carlo | 假设、证据、已排除方向、继续调查的理由与代价 |
| 生成→筛选→验证 | Uber、Trellix | 只交付可信产物，追溯被筛除／保留的原因，持续吸收反馈 |
| 长流程与人工介入 | LinkedIn、Replit | 暂停点、持久状态、跨轮次继续、准确输入目标和恢复路径 |

固定图、动态图和层级 Agent 可以组合；是否有图编辑器与运行时是否按图组织是不同产品问题。
纯串行图也可以有很高业务价值，只要它把可重复流程可靠自动化，并处理真实分支、状态与异常。

## 哪些用户场景更值得采用

### 1. 广度很大的研究与调查

例如供应商评估、跨仓库依赖调查、同类故障归因、多个组件的兼容性核对。
每个子任务有明确问题和证据来源，可以独立完成；汇总者比较矛盾、补足证据并形成结论。
收益来自并行取证和上下文分摊。[1] 的实际例子是调查标普 500 信息技术公司董事会成员。

代价不能忽略：[1] 报告 Agent 通常消耗普通聊天约 4 倍 token，多 Agent 系统约 15 倍。
**15 倍的分母是普通聊天，不是单 Agent。** 高价值、广覆盖任务更容易支付这项成本；简单问题没有必要启用整组 Agent。

Farming 候选流程：调查计划→若干独立证据任务→汇总／交叉验证。子项只回传带来源的结论和产物引用，不复制全部聊天记录。
这仍是建议用例，不是已经测得的 Farming 收益。

### 2. 输入多样但产出可验证的专业工程工作

Trellix 的场景比“自主开发整个产品”更有说服力：输入是不同日志格式或外部 API，输出是解析器或集成代码，工程师能够验收。[2]
同样适合探索的是按文件／模块分片的迁移、为失败用例定位与修复、批量生成有固定验收规范的适配器。

编译器实验揭示了关键前提：[5] 中 16 个 Agent 一度卡在相同内核错误上并互相覆盖修改；加入 GCC 对照、把失败拆成可独立定位的文件子集后才恢复并行收益。
**先把任务变得可分工、可测试，增加 Agent 才有效。**

该编译器仍依赖 GCC 完成部分启动与工具链工作，不能替代成熟编译器，生成代码效率也有明显不足。
不应据此许诺“无人团队可靠完成任意大项目”。

### 3. 跨数据源、跨工具的诊断与业务处理

Vodafone 的收益路径是让工程师用问题驱动取数和呈现，不再为每个问题手写查询或定制仪表盘。[3]
C.H. Robinson 则处理高频、格式不统一、经常缺字段的邮件订单，并追踪事务状态。[4]
这些流程经常需要串行步骤；收益来自自动化、工具衔接和异常处理，不一定来自并发提速。

Farming 候选流程：采集日志／配置／执行计划→分域分析→证据汇总→提出修复→用户确认后执行验证。
采集、校验、测试等确定性节点直接用程序即可；只有需要判断、探索的节点才用 Agent。
这是对案例的产品推导，不是案例本身已实现的 Farming 模板。

## 反证与边界

[7]《Towards a Science of Scaling Agent Systems》v3（2026-04-08）在六个基准、260 种配置中比较单 Agent 与四种多 Agent 架构。
摘要报告，相对单 Agent 的性能变化从可分解金融推理的 +80.8%，到串行规划的 −70.0%。
工具密集任务可能承担额外协调开销，缺少集中验证的架构更容易传播错误。
这是特定基准结果，不是所有生产工作流的普遍倍率；它说明任务结构比“Agent 越多越好”更重要。

Cognition 的 2025 年文章 [8] 强调上下文共享不足和分散决策导致的不一致。
它是历史工程立场，不是当前模型能力的统一上限；与后续成功实验合看，仍支持约束共享修改、明确任务合同和验证输出。

Cursor 的实验也记录过 20 个 Agent 因锁竞争退化到约 2–3 个的有效吞吐。[6]
更复杂的组织图不一定消除瓶颈，某些额外协调角色反而增加等待。

优先避免：

- 多个 Agent 同时修改强耦合模块，却没有精确写入归属与集成验证。
- 为一个简单问题固定安排“产品经理→架构师→开发→测试→审查”长链，每步只转述前文。
- 将主 Agent 的不确定判断一路传递，后续 Agent 不再查证原始证据。
- 只用代码行数、节点数、运行时长或表面完成率证明收益。

## 对 Farming 的建议

工作流监督应当成为明确的产品方向，不能只当作聊天列表的可选装饰。先用具体模板验证执行合同，再决定完整工作流编辑器的范围。
这是产品建议，不是本次扩展实现范围；不要求 Farming 自建所有 Provider 的编排器。

| 优先级 | 产品能力 | 对应用户收益 |
| --- | --- | --- |
| 先做 | 父子关系、精确状态、子会话右侧查看、产物与验证证据、能力驱动操作 | 用户能看到任务由谁执行、是否卡住、结果是否可信；旁聊与子 Agent 共用面板 |
| 小范围验证 | 专业代码审查→过滤／验证→汇总；动态故障调查→根因证据；独立工程任务→集成测试 | 每个模板都有明确产物、停止条件、人工介入与验收标准 |
| 随模板交付 | 工作依赖、汇合条件、阻塞原因、执行尝试、耗时与成本的图视图 | 主区显示执行结构，点击节点在右侧看精确子会话／产物，帮助找到关键路径和异常 |
| 再验证范围 | 通用拖拽编辑器、自然语言创建流程、团队模板分享 | Harvey 证明可复用自定义流程有需求；Farming 应根据实际模板使用验证编辑体验，而非预设节点越多越好 |

会话归属树与工作依赖图仍是不同事实。一个会话可执行多个工作节点，节点也可能只有程序而没有会话。
图中点击有会话的节点应复用右侧关联会话面板；程序节点打开产物和执行证据，不伪造聊天。
原生 Provider 没有上报的依赖和控制能力不能从聊天文本猜测出来。

试点以同一批任务、同等工具与清晰预算对比单 Agent 和工作流；同时记录总成本与墙钟时间。
成功指标应包括人工验收通过率、严重错误与回归、返工量、人类介入时间、结果证据完整性和失败恢复。
工作流只有在质量不下降且时间／人力收益足以支付协调与推理成本时，才值得升级成默认产品路径。

## 来源

1. Anthropic, [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system), 2025-06-13。生产架构与内部评测。
2. LangChain, [How Trellix cut log parsing time from days to minutes](https://www.langchain.com/blog/customers-trellix), 2025-04-21。客户案例，非独立审计。
3. LangChain, [Vodafone transforms data operations with AI](https://www.langchain.com/blog/customers-vodafone)。客户案例，未公开量化增益。
4. LangChain, [How C.H. Robinson is transforming the logistics industry](https://www.langchain.com/blog/customers-chrobinson)。客户案例，自动化业务指标。
5. Anthropic, [Building a C compiler with a team of parallel Claudes](https://www.anthropic.com/engineering/building-c-compiler), 2026-02-05；[公开代码](https://github.com/anthropics/claudes-c-compiler)。工程实验。
6. Cursor, [Scaling long-running autonomous coding](https://cursor.com/blog/scaling-agents)。工程实验与经验报告。
7. Kim et al., [Towards a Science of Scaling Agent Systems, v3](https://arxiv.org/abs/2512.08296v3), 2026-04-08。受控基准研究；本文数字采用 v3 摘要。
8. Cognition, [Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents), 2025。历史工程观点，用于分析失败模式。

9. LinkedIn, [How we engineered LinkedIn’s Hiring Assistant](https://www.linkedin.com/blog/engineering/ai/how-we-engineered-linkedins-hiring-assistant), 2025-10-21。一手架构：Supervisor、工具化子 Agent、后台执行与人类决策。
10. LinkedIn, [Hiring Assistant — shaped by customers, powered by AI innovation](https://www.linkedin.com/blog/engineering/hiring/hiring-assistant-shaped-by-customers-powered-by-ai-innovation), 2025-09-03。LangGraph 选型及早期客户结果。
11. Akshay Sharma / Lyft, [How Lyft Built a Self-Serve AI Agent Platform](https://www.langchain.com/blog/lyft-built-a-self-serve-ai-agent-platform-for-customer-support-with-langgraph-and-langsmith), 2026-05-27。具名团队一手工程分享，发布于 LangChain。
12. Harvey, [How We Rebuilt Playbook Review as a Multi-Agent System](https://www.harvey.ai/blog/rebuilding-playbook-review-as-a-multi-agent-system), 2026-09-02。三种架构比较、内部评测和生产实现。
13. Uber, [uReview: Scalable, Trustworthy GenAI for Code Review at Uber](https://www.uber.com/blog/ureview/)。一手工程文章，正文通过公开文本镜像读取；统计口径限制见正文。
14. LangChain, [Monte Carlo: Building Data + AI Observability Agents](https://www.langchain.com/blog/customers-monte-carlo)。具名产品经理与架构案例，未给出已验证效果倍率。
15. LangChain, [Pushing LangSmith to new limits with Replit Agent’s complex workflows](https://www.langchain.com/blog/customers-replit), 2024-09-26。已发布产品的多 Agent 追踪需求。
16. Harvey, [How Legal Teams are Working Better With 25,000+ Workflows](https://www.harvey.ai/blog/25000-custom-workflows), 2026-02-10。自定义工作流创建量与具名客户应用。
17. Harvey / GSK Stockmann, [Redefining the Due Diligence Process](https://www.harvey.ai/customers/gsk-stockmann)。具名客户工作流与分场景节时结果。
18. LinkedIn, [Quality Assurance Agent: Reimagining Software Quality with AI-Driven Autonomous Testing](https://www.linkedin.com/blog/engineering/ai/qa-agent-reimagining-software-quality-with-ai-driven-autonomous-testing), 2026-06-18。真实 QA 产品与多阶段验证，不作为多 Agent 消融实验。
