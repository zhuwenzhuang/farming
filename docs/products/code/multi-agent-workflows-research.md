# Multi-Agent Workflows: Industry Evidence And Farming Tradeoffs

> Chinese version: [multi-agent-workflows-research.zh_cn.md](./multi-agent-workflows-research.zh_cn.md)

Sources checked: 2026-09-17. This is product research and a recommendation, not a
claim that Farming has shipped workflow orchestration. See the
[Related Sessions and Side Chat design](related-sessions-design.md) for interaction contracts.

## Conclusion

**Graph-based agent engineering has clear production applications. Its value includes
reliable process execution, multi-turn handoffs, parallel work, persistent state and
iteration—not just a better answer to one question.** LinkedIn recruiting, Lyft
support, Harvey contract review and Uber code review provide more direct product
evidence than large autonomous-coding experiments.

Three questions should be distinguished:

- **Do workflow graphs have value?** Yes: deployed systems use them for routing,
  dependencies, state, verification, human intervention and execution recovery.
- **Do multiple agents have value?** Yes: specialized contexts and result reconciliation
  are in production. Harvey explicitly compares fixed pipelines, a single agent and
  an orchestrator with workers.
- **Does adding agents or graph nodes always help?** No. A node can be a program,
  model call, agent or human action; it need not be a role-playing persona.

Deployment, continued use and observable business outcomes are valid product evidence.
Missing equal-budget single-agent ablations limit causal attribution; they do **not**
mean there is no real product value. LangGraph use does not require a drag-and-drop
UI, but Harvey's adoption also demonstrates demand for reusable custom workflows.

Farming should support workflow supervision and execution evidence beyond child-session
lists. Code-review pipelines, dynamic incident-investigation graphs and engineering
batches are candidate pilots; their use should determine the scope of general visual
orchestration.

## Evidence Levels

Production means a source reports use in actual work, not independent audit.
Internal evaluations, customer stories and open engineering experiments are different
evidence. Automation gains over manual work are not multi-agent gains over a single
agent. This is a selected review of sources describing tasks, organization and results,
not an exhaustive industry ranking. Sources include product-team technical posts,
named engineers, named customer cases, framework-vendor reports and benchmark papers.
Uber blocked direct retrieval, so its article was read through a public text mirror;
we cite Uber and do not treat the mirror retrieval time as the publication date.

| Case | Organization | Reported outcome | Evidence and limits |
| --- | --- | --- | --- |
| LinkedIn Hiring Assistant [9][10] | Supervisor coordinates sourcing, evaluation and outreach, with async jobs, memory and human decisions; explicitly built on LangGraph | Early customers saved over four hours/role, reviewed 62% fewer profiles before shortlisting, and saw 69% higher InMail acceptance | First-party architecture and product reports; early customer results, not graph-engine-only attribution |
| Lyft AI Assist [11] | Stateful router → intent subgraph → specialist subgraph, mid-conversation handoffs, DynamoDB checkpoints | Millions of interactions; first driver agent took about six months, new configurable agents about two weeks; reported AI resolution rate up 16% | Named Lyft engineer's report; combined platform benefit, 16% not specified as percentage points; development comparisons involve different agents |
| Harvey Playbook Review [12] | Lead dispatches rules to up to dozens of workers, each editing a document branch; conflict reconciliation, final verification, persisted state | Old pipeline vs new: risk classification 59%→77%, redline rubric 53%→87%, mean latency 2.6→3.8 minutes | First-party three-architecture comparison and internal evaluation; higher quality but slower than the old pipeline |
| Uber uReview [13] | Functional/convention/security comment generation, then grading, filtering, deduplication and delivery | Six monorepos; median feedback four minutes; about 75% useful user feedback, about 65% of comments automatically classified as addressed in the same change | First-party production report; specialized multi-stage model workflow, not proof of an autonomous agent swarm |
| Monte Carlo data troubleshooting [14] | Dynamic investigation graph branches on findings across changes, timelines and dependencies | Describes hundreds of potential subagents and customer-demo preparation in four weeks | Concrete architecture case; root-cause validation still being developed, no established MTTR multiplier |
| Replit Agent application development [15] | Separate managing, editing and verifying agents across hundreds of steps and repeated human intervention | Released product whose parallel workflow required long-trace search and multi-turn aggregation | Real product and supervision needs, without a measured architecture-specific speedup |
| Anthropic Research: cross-company/source research [1] | Lead decomposes research; workers search independently and return compressed findings; lead synthesizes | Opus 4 lead plus Sonnet 4 workers outperformed single Opus 4 by 90.2% on an internal research evaluation | Deployed product and internal evaluation; not 90.2 percentage points or an equal-cost comparison; additional inference contributes |
| Trellix Sidekick: log parsers and integrations [2] | Small subgraphs composed into larger graphs, Send API map-reduce, engineer intervention | Log parsing from days to minutes; plugin development from days to the better part of an afternoon | Actual professional-services application, reported by its framework vendor; sample size, error rates and single-agent control not disclosed |
| Vodafone: operations data investigation [3] | Intent routing to retrieval or NL2SQL, query execution, analysis and visualization; modules as subgraphs | Two internal assistants on Google Cloud serve data-center engineers and reportedly reduce time to insight | Actual users and explicit multi-agent architecture; no quantified uplift or ablation published |
| C.H. Robinson: shipping emails to orders [4] | Interpret, classify, fill missing information, maintain order state, create order | Approximately 5,500 automated orders/day and over 600 hours/day saved | Substantial business-scale evidence for stateful workflows; does not establish that adding agents caused the savings |
| Anthropic C compiler experiment [5] | 16 agents divide failing tests, target projects and engineering roles; GCC oracle partitions kernel failures | Nearly 2,000 sessions, about $20,000 API cost, roughly 100,000-line compiler able to build Linux 6.9 | Public inspectable engineering artifact, not a mature production compiler or an equal-budget single-agent comparison |
| Cursor long-running engineering [6] | Planners generate tasks, workers execute, judge decides continuation; recursive planning | Browser experiment: roughly a week and over one million lines; Solid-to-React migration: over three weeks, CI/early checks passing but careful review still needed | Coordination feasibility; lines, commits and CI success do not establish delivered quality or ROI |

## Production Cases: What The Graph Actually Solves

### LinkedIn: Recruiting Is An Ongoing Process

[9] describes requirements clarification, sourcing, evaluation, outreach and feedback.
A supervisor coordinates interactive requests and asynchronous execution; sourcing
and evaluation continue as feedback arrives. [10] explicitly identifies LangGraph
and reports early customers saving more than four hours per role.

The graph preserves process context, hands off control and separates background
execution from human decisions. Subagents are modeled as tools rather than given
separate identities and mailboxes. Complex orchestration is useful, but one work
node need not correspond to one independent chat window.

### Lyft: Recoverable Specialist Support With Handoffs

[11] describes `Command(goto=...)` routing to subgraphs. An intent agent can hand
control back to the parent graph to dispatch a damage-claim specialist. Rider and
driver flows have separate routers. DynamoDB stores full graph state, execution
metadata and parent checkpoint references. Specialists share safety, tool and state
infrastructure; domain experts add coverage with prompts and configuration.

Graphs compose business flows, handle mid-conversation topic changes and retain
state beyond one process/request. All production agents have online evaluations;
the platform reports 20% lower hallucination/contradiction rates and a 16% increase
in AI resolution rate. These are combined platform results, not node-count effects.
Concrete code and operational details make this more informative than an adoption slogan.

### Harvey: Parallel Review Makes High-Quality Agentic Work Usable

[12] offers an especially useful comparison:

| Architecture | Quality | Latency | Reason to change |
| --- | --- | --- | --- |
| Fixed prompt pipeline | Moderate | Good | Classification, citation and editing lose context; rules conflict |
| Single reviewing agent | Good | Unacceptable | Iterative document reading/search/editing works but is too slow sequentially |
| Orchestrator plus rule agents | Good | Usable | Rules run in parallel; lead reconciles and verifies the whole result |

Each worker edits its own branch of a versioned document and returns rule-attributed
changes and a memo. Non-conflicting edits merge; collisions go to the lead. All
agents share necessary party, document-origin and negotiation context. State persists
so follow-up questions or changed positions reuse relevant work instead of rerunning
the complete graph.

Relative to the old pipeline, risk classification rises **18 percentage points** and
redline scoring **34 percentage points**; mean latency rises from 2.6 to 3.8 minutes.
These are not speedup numbers against the single-agent prototype, whose latency is
only described qualitatively as unacceptable. The target is better quality within
acceptable waiting time, not an improvement to every old-system metric.

This supports parallel work, isolated artifacts, conflict merging and final validation
as a useful engineering pattern. Separately, Harvey reports over 25,000 custom
workflows created [16]; creation is not active usage. GSK Stockmann [17] reports
initial time savings of 15–20% for structured diligence and up to 75% in unstructured
data rooms, not a universal 75% saving across legal work.

### Uber: Review Pipelines Are A Concrete Coding Use Case

[13] uses standard, best-practice and AppSec assistants to propose comments, then
validates, filters, deduplicates and selects useful feedback. It covers six monorepos,
with median feedback in four minutes and about 75% usefulness. The approximately
65% addressed rate is automatically inferred by re-review, not a human-confirmed
bug-fix rate.

The pipeline deliberately discards low-value output instead of presenting every
worker's opinion. Comments preserve provenance, category, confidence and developer
feedback, feeding improvements to specialist stages. The source inconsistently uses
weekly and monthly for its 65,000-diff figure, so that figure is not used here.

This does not establish LangGraph as necessary or every stage as an autonomous agent.
It does establish useful specialization → verification → synthesis → feedback in a
real coding product.

### Monte Carlo And Replit: Why Execution Structure Matters

Monte Carlo [14] starts at an alert and branches through changes, timelines and
dependencies. The graph contains actual hypotheses and evidence, rather than a
preset relay of analyst personas. It maps naturally to SQL, data-pipeline and
performance investigations. The case does not publish established root-cause
accuracy or MTTR multipliers; architecture and outcome evidence remain distinct.

Replit [15] has managing, editing and verifying agents across hundreds of steps.
Actual engineering needs include finding failures inside long traces and joining
multi-turn human interactions with execution. This supports work nodes, artifacts,
latency, failure locations and intervention points in Farming beyond names and chat.

As a boundary example, LinkedIn's QA Agent [18] reports over 200 valid bugs and uses
planning, execution and multi-stage error verification. It is real agent engineering,
but multiple models/stages do not establish an independently autonomous multi-agent
comparison.

## Reusable Graph Patterns

| Pattern | Examples | What users need |
| --- | --- | --- |
| Stateful routing and handoff | Lyft, LinkedIn | Current owner, collected information, next action and human decision points |
| Fan-out and join | Harvey, Anthropic Research | Branch progress, partial results, failure isolation, merge conflicts and final acceptance |
| Dynamic investigation graph | Monte Carlo | Hypotheses, evidence, eliminated paths and the reason/cost of further investigation |
| Generate → filter → verify | Uber, Trellix | Trustworthy artifacts, retention/rejection rationale and feedback |
| Long-running process with human intervention | LinkedIn, Replit | Pause points, persistent state, multi-turn continuation, exact input targeting and recovery |

Static graphs, dynamic graphs and hierarchical agents can compose. A graph editor
and a graph-organized runtime are different product choices. Even a sequential graph
can have substantial business value by reliably automating a repeatable process with
real branches, state and exceptions.

## Where Adoption Makes Sense

### Broad Research And Investigation

Examples include supplier comparisons, cross-repository dependencies, investigation
of similar failures, and compatibility across components. Each worker has a bounded
question and sources; the synthesizer resolves contradictions and evidence gaps.
Parallel collection and context distribution explain the value. A concrete example
in [1] is identifying board members across S&P 500 information-technology companies.

Cost matters: [1] reports agents using roughly 4 times ordinary chat tokens and
multi-agent systems roughly 15 times chat tokens. **The denominator for 15 times
is ordinary chat, not a single agent.** High-value broad research can justify that
cost; simple questions usually do not need a team.

A Farming candidate is investigation planning → independent evidence tasks →
synthesis/cross-checking. Workers return sourced findings and artifact references,
not their complete transcripts. This is a proposed use case, not measured Farming benefit.

### Specialist Engineering With Verifiable Outputs

Trellix is more convincing than a general promise to build whole products: varied
logs or third-party APIs are inputs, parsers/integration code are outputs, and engineers
can validate them [2]. Similar candidates are migrations partitioned by file/module,
isolated failing-test repairs, and adapters with fixed acceptance specifications.

The compiler experiment exposes the precondition. Sixteen agents became stuck on the
same kernel bug and overwrote one another. A GCC oracle that isolated failures into
file subsets restored useful parallelism [5]. Make the work divisible and testable
before increasing agent count.

The compiler still relies on GCC for parts of boot/toolchain work, is not a drop-in
replacement for a mature compiler, and produces inefficient code. It does not justify
a promise of reliable unattended completion of arbitrary large projects.

### Diagnosis And Business Processes Across Tools

Vodafone lets engineers ask questions that drive data retrieval and presentation,
reducing custom-query/dashboard work [3]. C.H. Robinson processes frequent,
inconsistently formatted emails with missing fields while tracking transaction state [4].
Many steps are sequential: value comes from automation, tool integration and exception
handling, not necessarily parallel speedup.

A Farming candidate is log/configuration/execution-plan collection → domain analyses →
evidence synthesis → repair proposal → user-authorized execution and verification.
Use programs for deterministic collection, checks and tests; reserve agents for
judgment and exploration. This is an inference for product design, not a deployed
Farming template reported by those sources.

## Counterevidence And Boundaries

*Towards a Science of Scaling Agent Systems*, v3 (2026-04-08), compares a single
agent with four multi-agent architectures across 260 configurations and six benchmarks
[7]. Its abstract reports relative changes ranging from +80.8% on decomposable financial
reasoning to −70.0% on sequential planning. Tool-heavy tasks may incur coordination
overhead; architectures without centralized verification propagate more errors.
These are benchmark-specific findings, not universal production multipliers. Task
structure matters more than simply increasing the number of agents.

Cognition's 2025 essay [8] emphasizes inconsistent decisions caused by incomplete
context sharing. It is a historical engineering position, not a universal ceiling on
current models. Read alongside later successful experiments, it supports bounded
shared edits, explicit task contracts and output verification.

Cursor reports an early lock-based arrangement where 20 agents fell to the effective
throughput of roughly two or three [6]. More organizational structure can add waiting;
some additional coordination roles made bottlenecks worse.

Avoid prioritizing:

- Concurrent edits to tightly coupled modules without exact write ownership and
  integration checks.
- A mandatory product-manager → architect → developer → tester → reviewer relay for
  simple tasks, with each stage merely restating its predecessor.
- Propagating an uncertain upstream judgment without rechecking source evidence.
- Treating code volume, node count, elapsed activity or superficial completion as value.

## Recommendations For Farming

Workflow supervision deserves an explicit product direction, beyond an optional
chat-list decoration. Validate execution contracts through concrete templates before
choosing the scope of a full editor. These are recommendations, not an expansion of
the current implementation scope or a requirement to rebuild every provider scheduler.

| Priority | Capability | User value |
| --- | --- | --- |
| First | Parent/child identity, exact state, right-side child inspection, artifacts and validation evidence, capability-driven controls | See who is working, what is blocked and whether results are supported; share the pane between Side Chat and native children |
| Limited validation | Specialist code review/filtering/verification; dynamic incident investigation/root-cause evidence; independent engineering/integration tests | Each template has artifacts, stop conditions, human intervention and acceptance |
| Deliver with templates | Dependency graph, join conditions, blocking reasons, execution attempts, time and cost | Main pane shows execution structure; selected nodes open exact child sessions/artifacts on the right, exposing critical paths and failures |
| Validate scope next | General visual editor, natural-language workflow creation and shared team templates | Harvey supports demand for reusable custom workflows; test Farming editing needs through actual template use rather than assuming more nodes are better |

Session ownership and work dependencies remain different facts. One session can
execute multiple work nodes; a node can be a program without a conversation. Clicking
a node with a session should reuse the right-side related-conversation pane. Program
nodes show artifacts and execution evidence, not fabricated chat. Do not infer
provider-native dependencies or control capabilities from conversation prose.

Pilot the same tasks with the same tools and explicit budgets, comparing a single
agent with the workflow. Record both total cost and wall-clock time. Measure human
acceptance, severe defects/regressions, rework, intervention time, evidence completeness
and failure recovery. Promote a workflow only when quality holds and time/labor gains
justify coordination and inference cost.

## Sources

1. Anthropic, [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system), 2025-06-13. Production architecture and internal evaluation.
2. LangChain, [How Trellix cut log parsing time from days to minutes](https://www.langchain.com/blog/customers-trellix), 2025-04-21. Customer story, not independent audit.
3. LangChain, [Vodafone transforms data operations with AI](https://www.langchain.com/blog/customers-vodafone). Customer story without quantified uplift.
4. LangChain, [How C.H. Robinson is transforming the logistics industry](https://www.langchain.com/blog/customers-chrobinson). Customer story with automation business metrics.
5. Anthropic, [Building a C compiler with a team of parallel Claudes](https://www.anthropic.com/engineering/building-c-compiler), 2026-02-05; [public code](https://github.com/anthropics/claudes-c-compiler). Engineering experiment.
6. Cursor, [Scaling long-running autonomous coding](https://cursor.com/blog/scaling-agents). Engineering experiments and experience report.
7. Kim et al., [Towards a Science of Scaling Agent Systems, v3](https://arxiv.org/abs/2512.08296v3), 2026-04-08. Controlled benchmark research; figures here follow the v3 abstract.
8. Cognition, [Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents), 2025. Historical engineering perspective on failure modes.

9. LinkedIn, [How we engineered LinkedIn’s Hiring Assistant](https://www.linkedin.com/blog/engineering/ai/how-we-engineered-linkedins-hiring-assistant), 2025-10-21. First-party supervisor, tool-like subagents, background execution and human decisions.
10. LinkedIn, [Hiring Assistant — shaped by customers, powered by AI innovation](https://www.linkedin.com/blog/engineering/hiring/hiring-assistant-shaped-by-customers-powered-by-ai-innovation), 2025-09-03. LangGraph implementation and early customer outcomes.
11. Akshay Sharma / Lyft, [How Lyft Built a Self-Serve AI Agent Platform](https://www.langchain.com/blog/lyft-built-a-self-serve-ai-agent-platform-for-customer-support-with-langgraph-and-langsmith), 2026-05-27. Named first-party engineering report hosted by LangChain.
12. Harvey, [How We Rebuilt Playbook Review as a Multi-Agent System](https://www.harvey.ai/blog/rebuilding-playbook-review-as-a-multi-agent-system), 2026-09-02. Three-architecture comparison, internal evaluation and production implementation.
13. Uber, [uReview: Scalable, Trustworthy GenAI for Code Review at Uber](https://www.uber.com/blog/ureview/). First-party engineering article retrieved through a public text mirror; metric limitations discussed above.
14. LangChain, [Monte Carlo: Building Data + AI Observability Agents](https://www.langchain.com/blog/customers-monte-carlo). Named product-manager and architecture case without a validated outcome multiplier.
15. LangChain, [Pushing LangSmith to new limits with Replit Agent’s complex workflows](https://www.langchain.com/blog/customers-replit), 2024-09-26. Multi-agent observability needs in a released product.
16. Harvey, [How Legal Teams are Working Better With 25,000+ Workflows](https://www.harvey.ai/blog/25000-custom-workflows), 2026-02-10. Custom-workflow creation count and named applications.
17. Harvey / GSK Stockmann, [Redefining the Due Diligence Process](https://www.harvey.ai/customers/gsk-stockmann). Named customer workflows and scenario-specific time savings.
18. LinkedIn, [Quality Assurance Agent: Reimagining Software Quality with AI-Driven Autonomous Testing](https://www.linkedin.com/blog/engineering/ai/qa-agent-reimagining-software-quality-with-ai-driven-autonomous-testing), 2026-06-18. Actual QA product and multi-stage verification, not a multi-agent ablation.
