# Farming CRT

> Chinese version: [README.zh_cn.md](./README.zh_cn.md)

Farming CRT is the keyboard-first control-room interface for Farming 2. It is not an old read-only skin or a lower-fidelity fallback: it controls the same live Agents, structured ACP sessions, native PTYs, Search, History, settings, and usage data as Farming Code.

![Farming CRT dashboard](assets/01-crt-dashboard.png)

Use CRT when several Agents are running, when terminal output is the main signal, or when direct keyboard control is faster than moving through a coding workspace. Use [Farming Code](../code/README.md) when files, editing, and multi-round Review need more room. Switching interfaces does not restart or duplicate Agents.

For the complete shared capability map, see the [Farming 2 product overview](../README.md).

## The Dashboard Is A Live Control Room

Agent cards occupy stable bays instead of continuously resizing around activity. One to four Agents use a `2 × 2` matrix, five or six use `3 × 2`, and seven to nine use `3 × 3`; larger sets page in groups of nine. Small screens reduce available rows or columns before cards fall below a readable minimum.

Each card shows:

- the human rename, provider session title, terminal title, or friendly provider name;
- running, waiting, unread, and optional heat state;
- the configured project name;
- a bottom-aligned ANSI-aware live terminal preview;
- a stable numeric shortcut badge.

The top bar reports active Agents, terminal-output token-rate estimate, CPU/MEM, host identity, local time, and uptime. The sidebar keeps New Agent, Search, History, Billing, Settings, and optional Main Agent supervision reachable without covering the grid.

Arrow keys move the reverse-video selection, Enter opens it, and Escape backs out of the current console. At page boundaries, Up and Down continue naturally into the previous or next Agent page while preserving the column.

## Open Structured Chat Without Leaving CRT

Codex, Claude Code, OpenCode, and Qoder ACP sessions open in a full-screen phosphor Chat surface rather than pretending to be PTY output.

![Structured Chat in Farming CRT](assets/02-crt-structured-chat.png)

History replay and live entries keep their order. The transcript shows user and Agent messages, while the composer exposes provider commands, model or mode configuration, token usage, attachments, pasted images, permission requests, queued follow-ups, and interrupt where supported.

Composer behavior is designed for terminal-oriented keyboard use:

- Enter sends and Shift+Enter inserts a newline;
- Chinese IME confirmation is not treated as submit;
- Down moves from the draft into the control strip;
- Left/Right choose a control and Enter opens its bounded options;
- when the transcript overflows, Tab focuses it, arrows page it, and Enter returns to the latest message;
- Escape returns one level or closes Chat at the session root.

Only a focused terminal runtime mounts xterm. Structured sessions remain native structured sessions and keep recovery errors inline.

## Open A Real Terminal

Terminal sessions open in a full-screen xterm.js surface with native keyboard, IME, ANSI color, scrollback, selection, copy, and full-screen TUI behavior.

![Native Terminal in Farming CRT](assets/03-crt-terminal.png)

The terminal first restores a dimension-matched backend screen and then applies incremental output. This matters for full-screen CLIs such as OpenCode and Qoder: replaying an arbitrary ANSI tail is not a valid terminal state.

Plain Escape remains available to the terminal application. Use `Ctrl+Escape` to close the CRT terminal, and `Ctrl+K` to kill the Agent. Opened terminals require the product xterm WebGL2 path rather than silently downgrading to a low-fidelity renderer.

## Switch The Actual Runtime With MSG / TTY

Compatible session headers expose `MSG` and `TTY`, with `Alt+M` as the visible shortcut. This changes the backend runtime, not just the presentation:

- `MSG` restarts into ACP structured Chat;
- `TTY` restarts into the native PTY CLI;
- the provider session is resumed when its identity has materialized;
- the overlay reports preparation, restart, and failure state, then follows the replacement Agent id.

A fresh Terminal with no user input can move into a fresh Chat before provider history exists. Once Terminal input has occurred, a missing history identity remains a visible error so Farming never silently drops the conversation.

## Search Live And Historical Work

Press `F` or choose **[F] SEARCH**. The query console matches live Agent titles, configured project names, and workspace paths, then adds resumable Codex, Claude Code, OpenCode, and Qoder sessions from the shared provider archive.

![Farming CRT Search](assets/04-crt-search.png)

Live Agents appear first. Provider sessions already represented by a live Agent are removed. Up/Down moves through results while the query keeps focus; Enter opens or resumes the selection; Escape returns to the dashboard.

## Continue, Restore, Or Resume From History

Press `H` to open the same History scope used by Farming Code: Farming run records, archived supported coding Agents, and unclaimed provider sessions, deduplicated by identity.

![Farming CRT History](assets/05-crt-history.png)

Rows identify the coding Agent and workspace. The primary action is explicit—Continue, Open, Restore, or Resume—rather than inferred from presentation state. Up/Down keeps selection continuous across pages, Left/Right moves a full page, Enter acts, and Escape returns.

Shells and unknown commands never become resumable provider history. Their archived process is destroyed instead of being presented as a recoverable coding session.

## Read Daily And Live Token Telemetry

**[$] BILLING** is an operational token console, not a monetary invoice.

### Days

The default view combines a logarithmic 120-day processed-token chart with a 52-week activity strip. Cache and direct tokens remain visually separate, so both quiet days and billion-token spikes stay legible.

![CRT Billing Days](assets/06-crt-billing-days.png)

Select a day to inspect its exact and compact total, input, output, cache read/write, 24 one-hour bins, and Codex/Claude/OpenCode shares. The current day is marked partial. Provider events are assigned by local date, including sessions that cross midnight.

### Live

Press `L` for a 60-minute token-rate oscilloscope, five-minute provider channels, quota windows, and reset timing.

![CRT Billing Live](assets/07-crt-billing-live.png)

Totals are provider-reported processed tokens and include cache reads. They are not cost or rate-limit consumption. Missing quota telemetry is stated explicitly. Qoder remains visible as unavailable when its local session files do not expose token fields; Farming does not estimate tokens from terminal output.

## Tune CRT Without Changing Farming Code

Settings provides the interface switch, CRT effects, optional Dynamic Heat, opened-terminal text size from 10–20 px, runtime information, and permission defaults.

![Farming CRT Settings](assets/08-crt-settings.png)

- CRT effects apply only under the CRT root and never leak into Farming Code.
- The opened-terminal font size updates immediately; Agent preview density remains stable.
- Dynamic Heat is off by default, keeping card sizing and color stable.
- Reduced-motion preferences disable motion-dependent effects.
- Choosing Farming Code returns to the shared Code session without restarting the Agent.

The disabled **[E] EXTENSIONS** slot is reserved for a future provider-neutral extension surface. CRT does not infer or install extensions independently.

## CRT On A Phone

Small viewports preserve readable cards and a fixed page instead of clipping a partial terminal preview below the frame. The available grid shrinks, paging appears when required, and the sidebar remains directly actionable.

<p align="center">
  <img src="assets/09-crt-mobile-dashboard.jpg" alt="Farming CRT mobile dashboard" width="360">
</p>

Opening an Agent uses the full mobile viewport for Chat or Terminal. The backend session is the same one visible on desktop.

## Live Rendering And Reconnection

Dashboard previews are monitoring summaries, not interactive terminal canvases. The client batches changed cards at most once per second and updates only affected cards. While a session is open, background dashboard rendering and preview streams are suspended for that client; closing it requests one fresh merged state.

When the browser tab is hidden, CRT closes its WebSocket and cancels reconnect work while backend Agents and PTYs continue. Returning opens one connection, restores dashboard state, and resynchronizes an open terminal before incremental output resumes.

Unread cards use a separate phosphor frame without changing layout. Opening the Agent advances the same attention read cursor used by Farming Code.

## Open CRT

The live entry is:

```text
<base-path>/crt/
```

With the defaults, open `/farming/crt/`. Farming Code Settings can also switch interfaces and carry the currently focused Agent into CRT.

## Detailed Design Documents

- [Farming 2 product overview](../README.md)
- [Shared CRT layout model](base_layout.md)
- [Desktop layout rules](pc_layout.md)
- [Mobile layout rules](mobile_layout.md)
- [Zombie cleanup and History implementation](zombie-history-implementation.md)
- [Repository README and installation](../../../README.md)
