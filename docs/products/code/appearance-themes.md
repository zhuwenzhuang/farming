# Farming Code Appearance Themes

> Chinese version: [appearance-themes.zh_cn.md](./appearance-themes.zh_cn.md)

Farming Code supports System, Light, Dark, and Paper appearances. Appearance is
a presentation preference only: changing it must not alter Agent, Session,
Project, file, or terminal state.

## Design Contract

- Light is the neutral, high-clarity default.
- Dark is the low-light appearance.
- Paper is an explicit light color scheme for sustained reading. It uses warm
  neutral layers, dark ink, and restrained agricultural green for focus,
  selection, links, and primary actions. Status colors keep their semantic
  meaning instead of being recolored green.
- Paper is flat color, not a texture filter. Repeated grain or global opacity
  effects reduce code legibility and are not part of the theme.
- Workbench chrome, reading surfaces, and raised controls must remain visually
  distinct. Theme colors should be selected by semantic role rather than by
  replacing individual hex values ad hoc.

## State Model

The persisted UI setting is the authoritative preference. Allowed values are
`system`, `light`, `dark`, and `paper`; invalid values normalize to `system`.
System resolves from `prefers-color-scheme` and therefore produces only Light
or Dark. Paper is always an explicit choice.

On initial navigation, the server writes the saved preference into the entry
document. The inline bootstrap resolves it before application CSS loads so the
browser canvas, theme color, and color scheme avoid a contrasting first paint.
After startup, the application owns the root and body appearance attributes.
Only a System preference reacts to operating-system color changes.

Changing appearance updates the document attributes, browser metadata, Monaco
theme, and terminal theme. A failed settings mutation follows the existing
settings rollback path; it must not leave a displayed preference that differs
from authoritative settings.

## CSS Ownership

`tokens.css` is the only CSS source allowed to branch on `data-appearance`.
It owns two layers: functional roles shared across the workbench (canvas,
surface, text, border, accent, status, editor, and terminal) and component
palette contracts for exceptional surfaces. Product-domain styles such as
Composer, Files, Settings, and Transcript own layout and interaction selectors,
but consume color tokens and remain appearance-neutral.

Do not add `<domain>-dark.css`, a Paper override sheet, or appearance selectors
inside a domain stylesheet. A new appearance must be expressible as token
assignments, with Monaco, Terminal, browser metadata, and first paint mapped to
the same palette contract. The static appearance CSS contract enforces this
boundary.

## Acceptance

- Each option can be selected and persists across reloads.
- Paper declares a light browser color scheme and uses its warm canvas before
  application startup.
- Navigation, Chat, composer, Settings, Files, Monaco, and Terminal repaint
  without requiring a reload.
- Primary and muted text remain readable, focus remains visible, and semantic
  success, warning, danger, and diff states remain distinguishable.
- Desktop and compact layouts do not introduce uncovered white or dark areas.
