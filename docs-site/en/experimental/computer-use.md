# Computer Use (Experimental)

<Badge type="warning" text="Experimental" />

::: warning Experimental feature
Computer Use has an implementation and automated verification but still lacks enough real-world cases. It is not a default Farming workflow, and its capabilities, dependencies, and interaction may change.
:::

Computer Use lets an Agent operate a full graphical environment, including applications, native dialogs, mouse, keyboard, screenshots, and accessibility information. Prefer [Farming Browser](../browser/overview) for structured web tasks.

## Current goal

Farming can provide an isolated Linux graphical environment. You can watch it and take control when needed. Missing container or runtime prerequisites remain explicit instead of triggering a hidden fallback.

## Control ownership

Only one controller acts at a time:

- while the Agent controls, the user observes;
- taking control stops Agent actions;
- after returning control, the Agent must observe fresh state before continuing.

A timed-out action has an uncertain outcome. Do not automatically replay submit, send, or delete operations.

## Isolation boundary

Each Computer belongs to one Agent and Project. Agents do not automatically share graphical Sessions, Profiles, authentication, or mutable filesystems. The isolated environment does not receive other Agents' private state or Host container-management access.

## Before enabling

- Start with recoverable tasks and non-sensitive accounts.
- Explicitly prepare and verify runtime dependencies.
- Keep a human takeover path.
- Do not use an experimental result as the sole evidence for a release or production action.
- Report environment, steps, and visible errors for real-world failures.
