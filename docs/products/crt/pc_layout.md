# Desktop Layout Design

> Chinese version: [pc_layout.zh_cn.md](./pc_layout.zh_cn.md)

This document describes CRT desktop layout for viewports at least `981px` wide. Shared layout rules are in [base_layout.md](base_layout.md).

## Overall Structure

```text
┌─────────────────────────────────────────────┐
│                  TopBar                     │
├──────────────────────────────┬──────────────┤
│                              │              │
│       Agents Layout          │   Sidebar    │
│                              │              │
└──────────────────────────────┴──────────────┘
```

The app container is a vertical flex column. TopBar is fixed-height at the top. Main content is horizontal: Agents Layout grows, Sidebar has fixed width on the right.

## TopBar

Desktop TopBar shows all status items, including Attn. It should remain compact and not reflow when values change.

## Sidebar

The desktop sidebar is fixed-width, vertically stacked, and divided into menu entries and a Main Agent panel.

```text
┌──────────────┐
│ [N] New Agent│
│ [L] Task List│
│ [H] History  │
│ [K] Skills   │
│ [$] Billing  │
│ [S] Settings │
├──────────────┤
│ MAIN AGENT[0]│
│ ┌──────────┐ │
│ │ preview  │ │
│ └──────────┘ │
└──────────────┘
```

Menu rows use compact CRT panel styling. Keyboard hints are visible, but keyboard actions should work even when the user does not click the sidebar.

## Main Agent Panel

The Main Agent panel sits below the menu list and embeds a compact agent preview. It should not dominate the sidebar.

## Dialogs

New Agent and Settings dialogs opened from the sidebar should use restrained CRT styling: thin borders, compact headers, and small typography.

## Session Modal

Desktop session modal uses a compact header and shell. Terminal canvas defaults to small monospace type so the modal feels like a control surface rather than a large dialog.

## Responsive Boundary

At `980px` and below, layout switches to the mobile menu strip and bottom Main Agent input. Desktop-specific spacing should not leak into mobile.
