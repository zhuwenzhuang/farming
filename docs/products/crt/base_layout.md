# Base Layout Design

> Chinese version: [base_layout.zh_cn.md](./base_layout.zh_cn.md)

This document defines shared layout concepts, data model expectations, and visual rules for the CRT skin. The supported desktop rules are documented in [pc_layout.md](pc_layout.md); [mobile_layout.md](mobile_layout.md) remains a concept and is not a current product surface.

## Overall Layout

The page has three persistent regions:

| Region | Responsibility |
| --- | --- |
| TopBar | system resources and attention hints |
| Agents Layout | central area showing working agents |
| Sidebar | menu entries and Main Agent panel |

`MapView.tsx` corresponds to the Agents Layout area.

## TopBar

TopBar items:

| Item | Format | Meaning |
| --- | --- | --- |
| Agents | `AGENTS: {active}/{total}` | active / total agent count |
| Token rate | `TOK/MIN: ~{rate}` | five-minute aggregate terminal-output token estimate |
| CPU | `CPU: {n}%` | system CPU usage |
| MEM | `MEM: {n}%` | system memory usage |
| Focus | `Focus: {name}` | focused agent when a session is open |
| Attn | `Attn: {name} [{score}]` | highest-attention agent when there is no focus |
| Uptime | `UPTIME: {time}` | system uptime, right-aligned |

Focus and Attn are mutually exclusive. Attn becomes hot when score is high, but the UI should avoid nagging notification patterns.

## Sidebar

Desktop sidebar entries:

| Key | Action | State |
| --- | --- | --- |
| N | NEW AGENT | enabled |
| F | SEARCH | enabled |
| H | HISTORY | enabled |
| E | EXTENSIONS | planned |
| $ | BILLING | enabled |
| S | SETTINGS | enabled |

Zombie cleanup does not get its own sidebar item. Zombie state appears on agent cards and in backend lifecycle rules.

Search replaces the former Task List slot. It opens a full-height search view in the Agents Layout region, keeps the query prompt focused, and combines live project Agents with unclaimed provider-session matches from the shared backend search API.

Billing replaces its former placeholder with a full-height token-telemetry view. Days is the default: a logarithmic 120-day processed-token bar chart stacks cache against non-cache volume, marks billion-token days, uses a fixed adaptive tokens-per-day Y axis plus a local-date X axis and selected-day cursor, and keeps a one-tick-per-day 52-week activity strip for long-range continuity. Processed totals include cache reads and combine every configured Codex and Claude Home with available OpenCode exports; unavailable providers remain explicitly identified. A compact line reports today, 7-day, 30-day, 52-week, active-day, billion-token-day, and peak values above the exact selected-day breakdown. The selected day also exposes a 24-bin local-hour total/cache curve and attributed provider shares without rescanning history on each selection. Left and Right move one day; Up and Down move one week. Live remains a secondary 60-minute Canvas oscilloscope with current signal, integral, peak rate, and active buckets. Provider channels and quota windows remain visible without inventing monetary costs or unavailable quota values. `$` opens Billing, `D` and `L` switch views, `R` refreshes it, and Escape returns to the Agent dashboard.

## Main Agent Panel

Render only when a Main Agent exists. It uses stronger visual emphasis than normal agents and opens the Main Agent session when clicked.

## Visual Principles

- compact information density;
- low visual noise;
- keyboard-first navigation;
- static layout where possible;
- no placeholder menu items for unimplemented actions.

CRT screen texture uses a flat phosphor-tinted black with static monochrome scanlines and no dark edge vignette. A low-contrast 300-pixel scan trail runs on the approximately 6.8-second reference cycle across both the dashboard and opened sessions; it has no separate bright line head. Numeric shortcut badges retain their green phosphor fill and dark text without an extra outline.

## Sessions

Session windows should use restrained CRT styling: thin borders, compact headers, and terminal-first focus. The terminal canvas should use small monospace type consistent with the global CRT density.

Agent cards keep a uniform readable font and use their remaining body height for either a bottom-aligned live terminal tail or a compact structured-Chat trail. The Chat trail shows the latest visible user prompt, Agent response, and current activity from the sanitized transcript without reconstructing or reordering ACP entries. Excess content clips instead of compressing text. Only live pending/running Agents occupy dashboard bays; stopped, dead, and archived records leave the live grid while resumable history stays in History. A terminal card blinks only while the backend terminal state is working; Chat uses a restrained activity signal. Card and session headers use the Farming Code agent-title priority and remain on one ellipsized line.

## Dialogs

New Agent and Settings dialogs should feel like lightweight CRT sheets or modals:

- compact title area;
- clear focused input;
- keyboard-confirmable actions;
- no heavy card nesting.
