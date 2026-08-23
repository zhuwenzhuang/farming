# Rest Reminder State Model

> Chinese version: [rest-reminder.zh_cn.md](./rest-reminder.zh_cn.md)

The Farming Pet rest reminder is a frontend-owned attention aid. It does not
own Agent lifecycle state and must not infer whether an Agent is running from
terminal or transcript text.

## Product Contract

- A due reminder is lightweight, non-modal, and safe to ignore while the user
  supervises work.
- A blocking rest scene starts only from a still-current, explicit **Start
  break** action. Deadlines, stale callbacks, expired controls, remounts, and
  other UI updates cannot enter rest.
- **In 10 min** atomically replaces the current reminder with one snoozed
  deadline. A stale or repeated action cannot create another deadline or revive
  the dismissed reminder.
- An active rest ends from **End break** or its absolute `restUntil` deadline.
  Ending rest starts a fresh foreground work cycle.

## State Ownership And Transitions

The Pet reducer owns `armed`, `working`, `due`, `snoozed`, and `resting`.
Foreground activity arms the work deadline; that deadline and the snooze
deadline may only produce `due`. Only the guarded `start` event may produce
`resting`, and it is accepted only while the authoritative current state is
`due`.

Runtime state is stored in session storage so refresh and remount restore the
same cycle. Restoration reconciles elapsed work, snooze, and rest deadlines,
but an overdue `due` reminder remains `due`; restoration never supplies user
intent. Timer effects read the current reducer state before committing, and
effect cleanup removes the exact timer it created.

## Acceptance Boundary

Tests must cover reminder arrival, snooze, explicit rest start, stale and
duplicate deadlines, rapid actions, an authoritatively running Agent, refresh
or remount, and both manual and timed rest completion. The acceptance failure
condition is any blocking rest scene without a current explicit start action,
or more than one reminder deadline for the same cycle.
