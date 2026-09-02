# Farming Code Appearance Themes

> Chinese version: [appearance-themes.zh_cn.md](./appearance-themes.zh_cn.md)

Farming Code supports System, Light, Dark, and Paper appearances. Appearance is
a presentation preference only: changing it must not alter Agent, Session,
Project, file, or terminal state.

The [UI design protocol](../../development/ui-design-protocol.md) governs shared
control families, typography, geometry, icons, responsive behavior and cross-page
equivalence. This document owns their appearance roles and theme lifecycle.

## Design Contract

- Light is the neutral, high-clarity default.
- Dark is the low-light appearance.
- Paper is an explicit light color scheme for sustained reading. Its workbench
  canvas, chrome, reading surfaces, Composer, editor, and terminal share one
  warm paper base. Hierarchy comes primarily from spacing, fine borders, and
  restrained neutral overlays rather than multiple yellow surfaces. Dark ink
  provides contrast. Pointer hover and selection use ink and neutral fills
  without decorative outlines; non-text controls may use a restrained, clearly
  visible ink ring for keyboard focus. Green remains only where it carries an
  actual semantic meaning such as success or data visualization. Status colors
  keep their semantic meaning instead of being recolored.
- Paper is flat color, not a texture filter. Repeated grain or global opacity
  effects reduce code legibility and are not part of the theme.
- Paper file tabs keep inactive labels in muted ink and the active label in
  strong ink, with one restrained tonal fill behind only the active tab.
  File-type, Provider, and semantic-status icons retain their own identity
  colors across the file tree, Open Editors, tabs, breadcrumbs, and Chat;
  ordinary navigation and action icons continue to use the neutral text hierarchy.
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
- Selected or active rows never add a left-edge line, bar, border, or rail, and
  one item must not stack competing selection cues. Active Agent and file rows
  use the opaque `--code-active-item-surface` role so their final rendered color
  matches across different parent surfaces without changing the generic
  `--code-bg-selected` role used by other controls. Light and Paper keep this
  active-item surface neutral; they do not use an accent-blue fill. Editor tabs
  use the document-connected `--code-file-editor-active-tab-surface`: Light and
  Dark connect the active tab to the editor canvas, while Paper retains its
  restrained neutral fill. Pointer hover and selection within the same Project,
  Agent, file, or editor-tab collection use the same surface instead of a
  second hover fill.
- A visually continuous control or state surface keeps one outer corner
  geometry across its base, hover or selection fill, overlay, and action
  layers. Asymmetric square and rounded ends require an explicit joined-control
  design; they must not result accidentally from overlapping layers.
- Persistent sidebar navigation uses the same neutral surface language for
  keyboard focus, pointer hover, and selection in every appearance. Project,
  Agent, file, Resource, menu, and sidebar action focus must remain visible
  through surface, text, icon, and action exposure without adding a colored
  perimeter or focus shadow.
- Text inputs and textareas indicate editing focus through the text caret, in
  every appearance and for both pointer and keyboard entry. Focus must not add
  an outline, shadow, or accent border to the field or its wrapper. Ordinary
  field boundaries and validation-error styling remain independent of focus.
  Buttons and selectors that need additional keyboard feedback use one restrained
  boundary, not stacked outline and shadow layers. Shared control-focus shadows,
  including Model Matrix, use a single one-pixel ring and never style text fields.
- Scroll containers are not navigation items. Clicking blank space, dragging
  their scrollbar, or focusing them for keyboard scrolling must not paint a
  selection surface or add a focus shadow to the whole container. Individual
  rows retain their hover, selection, and keyboard-focus feedback.
  Adjacent resize handles must not intercept the scrollbar's interaction lane.
- Native Farming Code scrollbars use one eight-pixel interaction lane with a
  four-pixel rounded thumb, a transparent track, and visible default, hover,
  and active states from the shared appearance registry. Domain styles must not
  redefine scrollbar geometry or colors. Monaco and Terminal keep their own
  renderer integration but map to the same geometry and state colors. A hidden
  scrollbar is limited to an explicitly documented alternative scrolling
  interaction such as the horizontal editor-tab strip.
- Navigation descendants consume the inherited `--code-navigation-surface`.
  The workspace maps that local role for each layout; responsive component
  rules may change geometry but must not choose a separate theme surface.
- Project, Agent, Files, Open Editors, and Git History share that navigation
  background, including sticky headers, inter-row gaps, and loading, empty,
  non-repository, and error messages. Expanding, focusing, or scrolling a
  collection never paints its container. Row hover, focus, and selection use
  the same opaque active-item surface; selected-plus-hovered states must not
  stack translucent fills or color the expanded details as another selection.
- Workbench regions remain legible without becoming separate color blocks.
  Paper panels, inputs, and grouped controls use a subtle neutral fill instead
  of decorative outlines or selected boundaries. Keyboard focus must remain
  visible through the appropriate text caret, control ring, fill, or other
  interaction feedback. Semantic status colors remain available inside their
  content. Theme colors should be selected by semantic role rather than by
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

`shared/appearance-themes.json` is the authoritative appearance registry. Each
resolved appearance defines the same complete CSS role set plus browser
metadata, Monaco, Terminal, Terminal search, and Mermaid palettes. The registry
is data rather than component selectors, so adding an appearance is a complete
typed inventory operation instead of a sequence of page overrides.

`tokens.css` is generated from that registry and contains exactly one rule for
Light, Dark, and Paper. It must not be edited by hand. Shared control recipes own
reusable geometry and interaction styling. Product-domain styles such as
Composer, Files, Settings, Transcript, Review, and extension frontends own
composition and domain-specific layout; they must not fork a shared recipe.
Both consume semantic color roles and remain appearance-neutral. They may not
contain appearance selectors or fixed Code colors.

The shared role set is intentionally bounded. Most roles describe layer,
content, interaction, or functional meaning: canvas, chrome, surface, raised,
inset, hover, selected, disabled, text hierarchy, border hierarchy, focus,
accent, info, success, warning, danger, diff, shadow, editor, and terminal.
Explicit palette exceptions are limited to visuals whose distinctions carry
product meaning, such as syntax, data charts, collaboration identities, Git
references, branded art, and Farming Pet artwork. Exceptions must use durable
semantic names;
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
- Native, Monaco, and Terminal scrollbars share geometry and default, hover,
  and active colors in every resolved appearance.
- Primary and muted text remain readable, focus remains visible, and semantic
  success, warning, danger, and diff states remain distinguishable.
- Text-entry tests cover pointer focus, Tab navigation, typing, and cancellation
  without a focus perimeter. Navigation and non-text controls retain their own
  visible keyboard feedback. Light, Dark, and Paper screenshot baselines cover
  the composed states; color-ratio assertions supplement, not replace, them.
- Desktop and compact layouts do not introduce uncovered white or dark areas.
