# 休息提醒状态模型

> English version: [rest-reminder.md](./rest-reminder.md)

Farming Pet 休息提醒是前端拥有的注意力辅助能力。它不拥有 Agent 生命周期状态，
也不能通过 Terminal 或 Transcript 文本推测 Agent 是否仍在运行。

## 产品契约

- 到期提醒必须轻量、非模态；用户监督工作时可以忽略它。
- 遮挡式休息场景只能由仍然有效的明确“开始休息”动作进入。deadline、旧回调、
  过期控件、重新挂载和其他 UI 更新都不能进入休息。
- “10 分钟后”必须原子地用一个 snooze deadline 替换当前提醒。过期或重复动作
  不能增加 deadline，也不能让已关闭的提醒复活。
- 已开始的休息由“结束休息”或绝对 `restUntil` deadline 结束；结束后开始新的
  前台工作周期。

## 状态所有权与转换

Pet reducer 拥有 `armed`、`working`、`due`、`snoozed` 和 `resting`。
前台活动建立工作 deadline；工作 deadline 和 snooze deadline 都只能产生
`due`。只有受保护的 `start` 事件能产生 `resting`，并且仅在权威当前状态仍为
`due` 时接受。

运行时状态保存在 session storage 中，因此刷新和重新挂载会恢复同一周期。
恢复时会核对已流逝的工作、snooze 和休息 deadline，但过期的 `due` 仍保持
`due`；恢复过程不能替代用户意图。计时 effect 提交前必须读取 reducer 的当前
状态，清理时只移除它自己建立的精确定时器。

## 验收边界

测试必须覆盖提醒出现、稍后提醒、明确开始休息、旧或重复 deadline、快速操作、
权威状态为运行中的 Agent、刷新或重新挂载，以及手动和到时结束休息。任何没有
当前明确开始动作的遮挡式休息，或同一周期存在一个以上提醒 deadline，均视为失败。
