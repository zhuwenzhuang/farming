# Farming 2 Product Overview

> Chinese version: [README.zh_cn.md](./README.zh_cn.md)

Farming 2 is an open-source, customizable browser workspace with two live interfaces: Farming Code for focused coding and review, and Farming CRT for keyboard-first monitoring and control. Both interfaces use the same backend Agents, provider sessions, native PTY processes, history, workspace files, and settings.

Multiple Farming deployments can additionally be collected in [Farming Net](net/README.md), a separate token-protected directory. Enrolled targets accept target-bound, short-lived signed passes without joining runtimes or exposing their normal tokens to the portal.

This document is the canonical public capability map and is updated in place as the product improves. Historical changes remain in [GitHub Releases](https://github.com/zhuwenzhuang/farming/releases).

Install and start:

```bash
npm install --global farming-code@latest && farming daemon
```

## The Product In One Minute

1. Open the authenticated browser URL from a desktop or phone.
2. Start an Agent in a workspace, or resume an existing provider session from Search or History.
3. Work in structured Chat when readability matters; open Terminal when exact CLI behavior matters.
4. Read files, inspect changes, edit a small fix, or open Review without leaving the Agent context.
5. Leave the page and return later. Agents stay on the host and live terminals can reconnect.

![Start an Agent](code/assets/02-start-agent-picker.png)

## Choose The Interface For The Moment

### Farming Code: understand and intervene

Farming Code keeps the current task readable. The final response stays prominent while plans, reasoning, tool calls, permissions, embedded terminals, child sessions, and exact patches remain expandable in their original order.

![Expanded Agent process in Farming Code](code/assets/11-code-agent-process.png)

Use it for long follow-ups, project files, quick editing, git evidence, and the initial workspace Review flow. The desktop layout keeps project context visible; the mobile layout focuses one surface at a time.

### Farming CRT: observe and control

Farming CRT keeps active work in stable control-room bays. It exposes the same structured and terminal sessions through a phosphor console, with direct keyboard navigation, Search, History, Billing telemetry, and display controls.

![Farming CRT dashboard](crt/assets/01-crt-dashboard.png)

Use it when several Agents are running, when keyboard control is faster than a workspace layout, or when terminal output and operational signals are the main concern.

## Capability Map

| Capability | Farming Code | Farming CRT | Shared backend behavior |
| --- | --- | --- | --- |
| Live Agent overview | Project groups, pinned and unread work | Stable paged Agent bays, live previews | One Agent state and attention cursor |
| Structured Chat | Rich ACP attention projection | Ordered phosphor transcript and composer | Same ACP history and live entry stream |
| Terminal | Full xterm session and composer controls | Full-screen xterm session | Same native PTY process and screen recovery |
| Chat / Terminal | Runtime control in Agent composer | `MSG` / `TTY` control | Restarts the actual runtime and safely resumes identity |
| Model and permissions | Live model matrix, Advanced controls, approval modes | Structured configuration menu | Capability-driven provider settings |
| Project files | Tree, Open Editors, search, Monaco, preview, diff, blame | Open referenced files through shared links | Root-bounded workspace API and git service |
| Review | Initial tracked/untracked workspace review, captured revisions, comments | Open the shared Review route | Snapshot-bound files and reviewed state; multi-round continuity is evolving |
| Search | Live Agents and provider archive | Query console with Open / Resume | One bounded provider-session search |
| History | Searchable run and provider archive | Keyboard list with Continue / Restore / Resume | Identity-based deduplication and shared scope |
| Usage | Compact usage/context/quota signals | Daily history and live oscilloscope | Provider-local telemetry with explicit unavailable states |
| Mobile | Focused Chat, Terminal, Files, drawer | Not currently supported; use Farming Code | Same authenticated service and sessions |
| Appearance | Light and dark | CRT effects, font size, Dynamic Heat | Interface choice persists without restarting Agents |

## Structured Work Without Losing Evidence

Codex, Claude Code, OpenCode, and Qoder use ACP for structured Chat. Farming does not reconstruct ACP history into a second backend conversation model: history replay and live events reduce into one ordered entry stream. The frontend can group process details for human attention, but expanding them restores the original order and tool detail.

![Structured ACP Chat in Farming CRT](crt/assets/02-crt-structured-chat.png)

The shared behavior includes:

- plans, reasoning, tool calls, permissions, images, files, and provider commands;
- embedded terminals and child sessions where the provider exposes them;
- follow-up messages queued visibly while a turn is active;
- interrupt and permission handling without inventing a second protocol;
- sanitized removal of internal Codex context envelopes while keeping user-visible automation notifications.

## One Session Can Be Chat Or Terminal

Terminal is a real PTY, not a transcript theme. Switching Chat / Terminal restarts the Agent into ACP or native PTY mode and resumes the same provider session when that identity has materialized.

A newly opened Terminal with no user input may move directly to a fresh ACP Chat before a provider history record exists. Once Terminal input has occurred, Farming refuses to discard the conversation silently: missing history becomes a visible error and the original runtime is restored.

![Live native Terminal in Farming Code](code/assets/12-code-terminal-session.png)

![Live native Terminal in Farming CRT](crt/assets/03-crt-terminal.png)

## Live Model And Permission Control

Farming renders the controls supported by the active runtime. Compatible Codex model families can expose a compact matrix for model variant and reasoning level, a separate Ultra charge control, Fast state, and approval mode. Unsupported Fast or Ultra capability stays in place but becomes grey and non-interactive, preventing the panel from jumping when metadata refreshes.

![Live model matrix](code/assets/07-live-model-controls.png)

**Advanced** changes the selection method without resetting the active profile. In a native Terminal session, a new selection is staged and sent to the current CLI workflow before the next user message, so the control is not merely a startup default.

## Files And Review Around The Task

Project Files belong to a concrete project Agent. The sidebar provides a lazy tree, Open Editors, path/line and content search, Git Changes, and Review. The central editor provides Monaco text editing with version checks, Markdown and image preview, diff, and blame.

![Project file with inline blame](code/assets/04-files-editor-blame.png)

The initial Review flow opens tracked and untracked workspace changes separately. It captures a revision, shows files and diffs, keeps comments and reviewed state with that snapshot, and can compare a later fix. Continuity for one set of findings across several review rounds is still being developed.

## Search And History

Search covers current projects and live Agents, plus resumable Codex, Claude Code, OpenCode, and Qoder sessions. Results already represented by a live Agent are deduplicated. History combines Farming run records, archived supported coding Agents, and unclaimed provider sessions.

![Farming Code Search](code/assets/13-code-search.png)

![Farming CRT Search](crt/assets/04-crt-search.png)

Shells and unknown commands do not become resumable provider sessions or provider History records. Their processes are destroyed when archived.

## Usage And Operational Awareness

Farming Code keeps usage signals compact. CRT Billing expands local provider data into two operational views:

- **Days**: a high-contrast 52-week daily activity calendar, exact selected-day totals with a prominent compact value at the right, a five-second current-day refresh whose digits catch up to new totals, a 24-cell local-hour coordinate strip aligned with a total/cache step trace, and provider shares.
- **Live**: 60-minute token-rate oscilloscope, five-minute provider channels, quota windows, and reset timing.

![CRT daily token history](crt/assets/06-crt-billing-days.png)

![CRT live token telemetry](crt/assets/07-crt-billing-live.png)

These are processed-token telemetry views, not invoices. Cache reads are included. Missing provider quota or token fields are shown as unavailable rather than estimated from terminal output.

## Desktop, Phone, And Return Visits

The browser is a control surface, not the process owner. Hidden tabs suspend their WebSocket and reconnect work; backend Agents and PTYs continue. Returning opens one socket, restores current state, and resynchronizes the focused terminal before incremental output resumes.

Farming Code mobile emphasizes one readable task surface and a drawer. Farming CRT is currently desktop-only; phones should use Farming Code.

## Runtime And Data Boundaries

- The Farming server owns auth, Agent lifecycle, session routing, files, history, Review, usage, and configuration.
- A separate native PTY host owns interactive terminal processes and can survive a Farming server restart.
- The browser receives bounded APIs and rendered session data; repositories remain on the host.
- Farming-owned session metadata lives under `~/.farming/sessions/`; run history lives under `~/.farming/history/`.
- Codex, Claude, OpenCode, and Qoder histories remain external read-only sources.
- Agent processes receive a resolved user shell environment plus an allowlisted set of relevant server variables, not a blind copy of the server environment.

## Where To Go Next

- [Farming Code product guide](code/README.md)
- [Farming CRT product guide](crt/README.md)
- [Farming Net deployment portal](net/README.md)
- [Mobile guide](code/mobile-guide.md)
- [ACP runtime](code/acp-runtime.md)
- [Review foundation](code/review-foundation.md)
- [Acceptance and dogfood plan](code/test/acceptance-dogfood-plan.md)
- [Repository README and installation](../../README.md)
