# Mobile Layout Design

> Chinese version: [mobile_layout.zh_cn.md](./mobile_layout.zh_cn.md)

This document describes CRT mobile layout for viewports up to `980px`. Shared layout rules are in [base_layout.md](base_layout.md).

## Overall Structure

```text
┌───────────────────────┬─────┐
│        TopBar         │     │
├───────────────────────┤[=]  │
│                       │[N]  │
│                       │[L]  │
│    Agents Layout      │[H]  │
│                       │[K]  │
│                       │[$]  │
│                       │[S]  │
├───────────────────────┴─────┤
│ [M]  [___input___]    [↵]  │
└─────────────────────────────┘
```

The outer app container is a vertical flex column. TopBar stays at the top, the main content contains Agents Layout and the narrow right menu, and the Main Agent input strip stays at the bottom.

## TopBar

Mobile TopBar is thinner than desktop:

- hide Attn to save horizontal space;
- use compact padding;
- allow horizontal overflow if needed;
- reduce font size on very narrow screens.

## Right Menu Strip

Collapsed width is intentionally narrow. It contains:

- toggle;
- New Agent;
- Task List;
- History;
- Extensions (planned);
- Billing;
- Settings.

When expanded, it shows labels but should not cover the entire main content longer than necessary.

## Main Agent Input

The bottom input strip is optimized for short interventions. Inputs should keep a `16px` font size to avoid iOS zoom behavior.

## Dialogs

New Agent and Settings open as bottom sheets. Workspace path input should be large enough for mobile editing and should not trigger password-manager overlays.

## Terminal

Mobile terminal should:

- keep output readable;
- avoid page-wide horizontal overflow;
- avoid accidental keyboard popups when reading output;
- keep input and send controls visible when the keyboard is open.

## Interaction Rules

- The primary action should remain reachable by thumb.
- The menu strip is a navigation aid, not a dense desktop sidebar.
- Session content gets priority over chrome.
- Narrow-screen CSS must not change desktop CRT behavior.
