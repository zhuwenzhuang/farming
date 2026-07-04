# Farming Hive

> Chinese version: [README.zh_cn.md](./README.zh_cn.md)

Farming Hive is a proposed product skin for reproducing the useful parts of Gas City inside Farming without inheriting Gas City's terminology burden.

It is not another general agent-session skin. Farming Code is a workbench for live Codex / Claude / shell sessions; Farming Hive is a managed-task console. The main object is not the agent terminal, but the task that has been handed to the system and should keep moving with minimal human attention.

## Product Position

Farming Hive should replicate the Gas City capability model:

- persistent managed tasks;
- assignable workers;
- task progress and attempts;
- attention signals;
- task messages;
- artifacts and review;
- system health and event history.

The skin should not expose Gas City words such as `city`, `rig`, `bead`, `sling`, or `formula` as user-facing navigation. Those may remain adapter or implementation concepts. The user-facing model should stay small and direct.

## Hive Metaphor, Factory Effect

The hive metaphor is still the right product skin. It gives Farming a calm, living, observable surface: many small workers move in the background, the human inspects the hive only when something needs attention, and finished work can be collected.

The software factory is the operational effect, not the primary vocabulary. When Farming Hive works, it should feel like a software factory underneath:

- tasks enter a durable queue;
- workers pick up or receive work;
- workflows move tasks through repeatable steps;
- checks and review act as quality gates;
- results are collected and accepted.

But user-facing concepts should stay closer to human language. `Project`, `Task`, `Worker`, `Progress`, `Alert`, and `Result` are the information architecture. `Worker bee` and `Harvest` are allowed flavor. `Factory`, `line`, `station`, and `quality gate` can appear in advanced explanations, but the default UI should not require the user to learn another metaphor stack.

## Concept Model

Farming Hive uses six primary concepts:

| User Concept | Meaning | Gas City Equivalent | Engineering Equivalent |
| --- | --- | --- | --- |
| Project | A repo or workspace boundary. | City / rig scope | Workspace / project scope |
| Task | A managed work item handed to the system. | Bead | Managed task |
| Worker | An agent or session that can do work. | Agent | Worker / agent session |
| Progress | What has happened while trying to finish the task. | Run / activity | Attempt timeline |
| Alert | A human-attention signal. | Mail / blocked / needs-you / health signal | Attention signal |
| Result | Something ready to inspect, accept, merge, or archive. | Output / close result / artifact | Artifact / result |

Two light beekeeping terms are allowed:

- **Worker bee** may be used as a visual/personality layer for `Worker`.
- **Harvest** may be used as an action flavor for reviewing and accepting results.

Avoid using beekeeping terms as a full information architecture. The hive can be the skin and spatial metaphor, but users should not have to distinguish between hive, honeycomb, cell, nest, buzz, or colony as separate product concepts. The product structure should be human-language first and beekeeping-flavored second.

## Gas City Mapping

This skin is deliberately a Farming-shaped facade over Gas City-like mechanics.

| Gas City Concept | Farming Hive User Concept | Notes |
| --- | --- | --- |
| Supervisor | System status | Should live in Health/Admin, not primary navigation. |
| City | Project | A top-level managed workspace. |
| Rig | Project / worker group | Only expose when the user needs to filter or route. |
| Bead | Task | The main unit of work. |
| Sling | Assign worker | A verb/action, not a noun the user must learn. |
| Agent | Worker | A runnable AI/session worker. |
| Formula | Workflow template | Advanced configuration, not core navigation. |
| Formula run | Attempt / progress run | Appears inside task progress. |
| Mail | Alert / message | Only escalated messages become Alerts. |
| Activity | Progress / system events | Split user task progress from admin event history. |
| Health | System status | Kept, but secondary to managed work. |

## Navigation

The first version should use this structure:

```text
Projects
Tasks
Workers
Alerts
Results
Health
```

The default landing page should be a project-level command view:

```text
Project: odps_src

Needs attention      3
In progress          7
Ready to review      2
Quietly waiting     12

Top alerts
Recent results
Active workers
```

The page should answer four questions quickly:

1. What needs me now?
2. What is actively moving?
3. What is ready to accept?
4. Which workers are stuck, idle, or overloaded?

## Core User Stories

### Create A Managed Task

The user creates a Task with:

- goal;
- project;
- context;
- acceptance criteria;
- optional worker preference;
- priority.

The button should say `New task`, not `New bead`.

### Assign A Worker

The user can assign or reassign a worker from the task detail page.

User-facing copy should say:

- `Assign worker`;
- `Ask another worker`;
- `Pause`;
- `Resume`;
- `Stop`.

The underlying action may map to Gas City `sling`, but that term should not appear in the skin.

### Watch Progress

Each task has a progress timeline:

- created;
- assigned;
- worker started;
- files inspected;
- command/test run;
- blocked;
- result produced;
- ready for review;
- accepted/archived.

Terminal/session output should be available from the timeline, but the terminal is supporting evidence rather than the page's main object.

### Handle Alerts

Alerts are filtered human-attention events:

- worker asks a question;
- permission or credential is needed;
- tests failed after retries;
- merge/review is waiting;
- worker appears stuck;
- system health threatens task progress.

Alerts should not be generic notification dots. They should explain the decision the user can make.

### Review Results

Results are task artifacts:

- diff;
- test output;
- report;
- screenshot;
- PR;
- command transcript;
- final summary.

The primary result actions are:

- `Review`;
- `Accept`;
- `Ask for changes`;
- `Archive`.

The beekeeping-flavored verb `Harvest` can be used as a secondary visual phrase, but `Accept result` should remain available in plain language.

## Data Model Sketch

The skin can be built on this model:

```text
Project
  id
  name
  workspacePath

Task
  id
  projectId
  title
  goal
  acceptanceCriteria
  status
  priority
  assignedWorkerIds[]
  currentAttemptId?
  resultIds[]
  alertIds[]

Worker
  id
  provider
  sessionId
  projectId
  state
  currentTaskId?

Attempt
  id
  taskId
  workerId
  status
  timelineEvents[]

Alert
  id
  taskId?
  workerId?
  severity
  reason
  requestedDecision

Result
  id
  taskId
  type
  status
  artifactRefs[]
```

Gas City adapters can map:

- bead -> Task;
- agent/session -> Worker;
- formula run/order run -> Attempt;
- mail/attention/health signals -> Alert;
- close result/artifacts -> Result.

## Visual Direction

The beekeeping metaphor should influence motion and texture, not vocabulary:

- workers can appear as small active units moving around task cards;
- task cards can be grouped in a comb-like layout, but the label remains `Tasks`;
- alerts can pulse gently instead of using aggressive red dots;
- results can have a harvest/collection feel.

The skin should remain work-oriented. Avoid cute or game-heavy language that makes serious coding work feel toy-like.

## First Prototype Scope

The first prototype should prove:

1. A project page can show managed-task health at a glance.
2. A task can be created and assigned to a worker.
3. A task detail page can show progress, alerts, terminal evidence, and results.
4. The user can review a result and archive the task.
5. System health is visible without becoming the main screen.

This is intentionally different from Farming Code. Farming Code starts from sessions and files. Farming Hive starts from tasks and attention.
