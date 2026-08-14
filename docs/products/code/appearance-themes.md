# Farming Code Appearance Themes

> Chinese version: [appearance-themes.zh_cn.md](./appearance-themes.zh_cn.md)

Farming Code supports System, Light, Dark, and Paper appearances. Appearance is
a presentation preference only: changing it must not alter Agent, Session,
Project, file, or terminal state.

## Design Contract

- Light is the neutral, high-clarity default.
- Dark is the low-light appearance.
- Paper is an explicit light color scheme for sustained reading. Its workbench
  canvas, chrome, reading surfaces, Composer, editor, and terminal share one
  warm paper base. Hierarchy comes primarily from spacing, fine borders, and
  restrained neutral overlays rather than multiple yellow surfaces. Dark ink
  provides contrast. Ordinary interaction uses ink and neutral fills without
  focus rings or selected outlines; green remains only where it carries an
  actual semantic meaning such as success or data visualization. Status colors
  keep their semantic meaning instead of being recolored.
- Paper is flat color, not a texture filter. Repeated grain or global opacity
  effects reduce code legibility and are not part of the theme.
- Paper file tabs keep inactive labels and icons in the same muted ink on the
  tab-strip paper. The active label and icon use the same strong ink together,
  with one restrained tonal fill behind only the active tab.
- Paper icon buttons rest directly on their parent paper surface. Only a
  selected or pressed toggle keeps the deeper selected fill; hover fill is
  temporary and an idle unselected button has no local background.
- Persistent desktop navigation uses the chrome role. The compact fixed top bar
  and navigation drawer use the panel-surface role; their sticky Project,
  Agent, and Files regions inherit that same surface. Raised is reserved for
  overlays that leave the normal document flow. Idle controls inherit their
  structural parent instead of substituting a canvas or raised background.
- A current Agent uses exactly one selected fill, including its leading
  provider identity icon. Unselected section headers such as Files remain on
  the panel surface and must not resemble a second selection.
- Parallel representations of the same active item use the same selected fill;
  for example, the active file row and its editor tab must match. Selected or
  active rows never add a left-edge line, bar, border, or rail, and one item
  must not stack competing selection cues.
- A visually continuous control or state surface keeps one outer corner
  geometry across its base, hover or selection fill, overlay, and action
  layers. Asymmetric square and rounded ends require an explicit joined-control
  design; they must not result accidentally from overlapping layers.
- Navigation descendants consume the inherited `--code-navigation-surface`.
  The workspace maps that local role for each layout; responsive component
  rules may change geometry but must not choose a separate theme surface.
- Workbench regions remain legible without becoming separate color blocks.
  Paper panels, inputs, and grouped controls use a subtle neutral fill instead
  of decorative outlines, focus rings, or selected boundaries. Text, cursor,
  fill, and interaction state provide the required feedback. Semantic status
  colors remain available inside their content. Theme colors should be selected
  by semantic role rather than by replacing individual hex values ad hoc.

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

`shared/appearance-themes.json` is the authoritative appearance registry. Each
resolved appearance defines the same complete CSS role set plus browser
metadata, Monaco, Terminal, Terminal search, and Mermaid palettes. The registry
is data rather than component selectors, so adding an appearance is a complete
typed inventory operation instead of a sequence of page overrides.

`tokens.css` is generated from that registry and contains exactly one rule for
Light, Dark, and Paper. It must not be edited by hand. Product-domain styles
such as Composer, Files, Settings, Transcript, Review, and extension frontends
own layout and interaction selectors, but consume semantic color roles and
remain appearance-neutral. They may not contain appearance selectors or fixed
Code colors.

The shared role set is intentionally bounded. Most roles describe layer,
content, interaction, or functional meaning: canvas, chrome, surface, raised,
inset, hover, selected, disabled, text hierarchy, border hierarchy, focus,
accent, success, warning, danger, diff, shadow, editor, and terminal. Explicit
palette exceptions are limited to visuals whose distinctions carry product
meaning, such as syntax, data charts, collaboration identities, Git references,
branded art, and Farming Pet artwork. Exceptions must use durable semantic names;
selector-derived or hashed names are not contracts. Fixed artwork hues that do
not vary by appearance must be declared once as a small, named component palette;
all surrounding text, chrome, borders, focus, and derived opacity or shadow must
still consume appearance roles. The static contract allowlists only the Model
Matrix identity hues and the Pet black-hole preview palette.

Farming CRT has an independent skin palette in `crt-tokens.css`. Its fixed CRT
colors are not Code appearance roles and must not be mixed into the Code theme
registry.

Do not add `<domain>-dark.css`, a Paper override sheet, selector-level palette
tokens, or appearance selectors inside a domain stylesheet. The entry-page
first-paint block is generated from the same registry. Server-rendered metadata
and all JavaScript color consumers read the registry directly. Static contract
tests reject incomplete themes, stale generated output, hashed tokens, fixed
Code colors, and appearance branching outside the generated file.

## Acceptance

- Each option can be selected and persists across reloads.
- Paper declares a light browser color scheme and uses its warm canvas before
  application startup.
- Navigation, Chat, Composer, Settings, Files, Review, Browser and Computer
  extensions, Monaco, Terminal, and Mermaid repaint without requiring a reload.
- Primary and muted text remain readable, focus remains visible, and semantic
  success, warning, danger, and diff states remain distinguishable.
- Desktop and compact layouts do not introduce uncovered white or dark areas.
