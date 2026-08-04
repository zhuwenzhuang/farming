# Agent Cleanup And History

> Chinese version: [agent-cleanup-history.zh_cn.md](./agent-cleanup-history.zh_cn.md)

History records completed Agent lifecycles; it is not a second live-session
owner.

The Agent lifecycle owner decides whether an Agent is live and performs exact
termination. The History store owns archived summaries. The browser only
presents those authoritative results.

A user ends any Agent, including Main Agent, through the Archive lifecycle.
Conservative inactivity policy and natural process exit may archive non-Main
Agents. Farming removes an Agent from the live list only after a terminal
runtime outcome, then records one archive summary containing user-relevant
identity, workspace, timing, and end reason. CRT keeps the compact `KILL` label,
but that control requests the same Archive operation as Farming Code.

Main Agent is never selected by automatic cleanup, but the user may archive it
explicitly. Age alone is not proof that
a runtime stopped. Repeated observation of the same terminal lifecycle must not
create conflicting archive results.

If termination cannot be proven, the Agent remains visible with a retryable
failure. If termination succeeds but History persistence fails, Farming reports
the archive failure separately and does not claim that History was recorded.

Verification must cover manual termination, inactivity selection, natural exit,
Main Agent exclusion, duplicate terminal observations, persistence failure, and
restart reconciliation.
