# Base Layout Design

> Chinese version: [base_layout.zh_cn.md](./base_layout.zh_cn.md)

This document defines shared layout concepts, data model expectations, and visual rules for the CRT skin. Desktop and mobile variants are documented in [pc_layout.md](pc_layout.md) and [mobile_layout.md](mobile_layout.md).

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
| L | TASK LIST | enabled |
| H | HISTORY | enabled |
| K | SKILLS | enabled |
| $ | BILLING | enabled |
| S | SETTINGS | enabled |

Zombie cleanup does not get its own sidebar item. Zombie state appears on agent cards and in backend lifecycle rules.

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

Agent cards keep a uniform readable font and use their remaining body height for a bottom-aligned live terminal tail; excess content clips from the top and text must never be compressed. A card blinks only while the backend terminal state is working. Card and session headers use the Farming Code agent-title priority and remain on one ellipsized line.

## Dialogs

New Agent and Settings dialogs should feel like lightweight CRT sheets or modals:

- compact title area;
- clear focused input;
- keyboard-confirmable actions;
- no heavy card nesting.
