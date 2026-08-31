# Farming Code UI Design Protocol

> Chinese version: [ui-design-protocol.zh_cn.md](ui-design-protocol.zh_cn.md)

Farming Code uses one design contract across navigation, Chat, Composer, Files,
Review, Settings, dialogs, menus, and Farming-owned extension controls, including
standalone Code views. Light, Dark, and Paper are appearances of that same UI.
Farming CRT and Farming Net retain their separately documented product skins;
embedded third-party content retains its renderer, not ownership of Code chrome.

This protocol owns element equivalence, shared control specifications, and
acceptance. The [appearance contract](../products/code/appearance-themes.md)
owns palette and surface roles. The [interaction protocol](ui-interaction-protocol.md)
owns event arbitration and focus transfer. Product documents own business
semantics and domain behavior. These boundaries compose; none permits a local
visual exception to another without a documented product reason.

## Element Equivalence

Before designing or changing a control, identify its **semantic family, hierarchy,
size/density variant, and state**. Within the same appearance, elements with the
same classification must use the same specification and shared implementation,
regardless of which page, Project, Agent provider, or extension renders them.

The specification includes typography, iconography, slots and alignment,
spacing, control and hit-area geometry, surfaces, borders, corners, elevation,
motion, and interaction feedback. Matching a color token alone is insufficient.
Compare resolved styles and visible results, not just matching CSS declarations.

Variants describe a user-visible role or constraint. A primary action may differ
from an auxiliary action; a two-line Resource row may differ from a single-line
file row. A context menu does not become a different family because it opens
from Project instead of Agent. Do not invent a page-specific variant to preserve
an accidental difference. When roles differ, their shared parts still reuse the
same label, icon, action, and status specifications.

Form choices and numeric text entry share field typography and outer geometry.
A toolbar choice uses the explicit compact, borderless variant; it does not
change its popup menu specification. A nested menu that becomes an inline group
on a narrow screen shares its parent's outer surface, rather than drawing a
second floating shell. Rich choices may add a description line without changing
single-line command typography or state colors.

## Semantic Families

This is a classification contract, not a requirement for one universal component.
Use a shared component for repeated structure and behavior, or a shared CSS
recipe when semantic markup must differ. A recipe is the complete styling of a
family and its supported variants, owned in one place.

| Family | Typical consumers | Shared specification | Legitimate differences |
| --- | --- | --- | --- |
| Navigation item | Projects, Agents, Settings navigation | Leading identity, label, trailing actions, selection and focus | Hierarchy, named density, status content |
| Content row | Open Editors, file trees, Changes, search/history results, Resources | Label roles, slots, action reveal, active and focused surfaces | Tree depth, one/two-line content, domain metadata |
| Section heading | Files, Open Editors, Resource groups, panel sections | Chevron, heading, count and action alignment | Hierarchy, collapsibility, available actions |
| Button / icon button | Toolbars, Composer, panel headers, row actions | Named sizes, icon geometry, hit area, priority and state feedback | Primary/secondary/auxiliary, destructive semantics |
| Menu / menu item | Project, Agent, file, Review and extension action menus | Row density, typography, icon/check/shortcut slots, radius, elevation | Available commands, checked/disabled/destructive state |
| Form field / selector | Settings, dialogs, filters, workspace selectors | Label, value, placeholder, helper/error text, field geometry | Text entry versus choice, single/multiline, validation |
| Tab | Documents and equivalent view collections | Active/inactive treatment, close action, overflow and focus | Document-connected versus standalone navigation, documented by role |
| Overlay shell | Menus, popovers, dialogs, drawers | Surface/elevation roles, header and action conventions | Modality, anchoring and width policy; these are distinct overlay roles |
| Feedback | Loading, empty/error states, badges, notifications | Status meaning, label/icon treatment, progress and recovery hierarchy | Blocking versus inline feedback, severity and domain wording |
| Content surface | Transcript, Markdown, code, diff, editor and terminal | Text and surface roles, surrounding controls, scrollbars | Prose/code typography, syntax/diff and renderer-specific behavior |

For example, the same file basename in Open Editors and the directory tree uses
the same label typography at the same density and state; tree indentation does
not justify a separate font. A menu command and a combobox option may share visual
parts but retain menu and listbox semantics respectively.

## One Owner Per Design Decision

| Layer | Owns | Must not own |
| --- | --- | --- |
| Semantic tokens | Palette roles and shared typography, spacing, geometry, elevation and motion scales | Page-specific selectors or copies of the same value per consumer |
| Family component / recipe | Slots, concrete token choices, variants and composed interaction states | Business state inferred from visual styling |
| Product composition | Which controls appear, content, hierarchy, layout and domain actions | Overrides of a shared family's font, icon, radius or state treatment |
| Runtime / interaction owner | Authoritative operation state, selection and event ownership | Per-page reinterpretations of shared visual states |

Keep appearance-independent metrics in one shared metrics owner rather than
duplicating them across theme palettes. Keep the existing appearance registry as
the palette authority. An appearance may map surface roles differently, but must
not change a family's typography, geometry, action inventory or interaction
semantics. A shared metric must be consumed by rendering and any
dependent geometry, including virtual rows, sticky regions and hit testing.
Do not maintain a second JavaScript constant for a CSS dimension.

Concrete values belong in that shared owner and its acceptance expectations.
This protocol does not promote every current local pixel value into a standard.
Existing documented density decisions, such as the
[Project Files contract](../products/code/project-files-section-design.md#visual-and-interaction-rules),
remain constraints until their owner is explicitly changed.

Domain styles may arrange a component and supply documented variants. They must
not silently redefine a family metric through inherited custom properties,
inline styles, stronger selectors, or `!important`. If a domain needs a missing
variant, change the shared specification and verify its peers. Keep resets below
component typography in the cascade; a global `font: inherit` must not erase a
button's specified label size, weight or line height. Lazy loading and import
order must not decide which design wins.

## Typography, Icons And Composition

- Define complete text roles: family, size, weight, line height and spacing.
  Heading, primary label, secondary label, metadata, placeholder, action and code
  roles must have stable hierarchy. Auxiliary actions must not accidentally
  outrank their labels through font inheritance or unrelated emphasis.
- The same action uses the same glyph, optical size and stroke/fill treatment.
  Do not substitute text dots, emoji, Unicode crosses or a private SVG for an
  existing shared action icon. Icon drawing size and hit-area size are separate
  decisions. Provider/file identity and semantic-status artwork retain the
  exceptions defined by the appearance contract.
- Use explicit leading, label/metadata and trailing slots. Persistent actions
  participate in width allocation; text truncates before them. Hover overlays
  must not obscure a required status, mix label text into icons, or create
  overlapping click targets. Long names, localization and optional actions must
  preserve alignment and access to the full identity.
- A continuous surface has one outer geometry across its base, state fill and
  action layers. A larger dialog and a small button need not share a radius;
  two equivalent menus do. Width may follow content without changing the menu's
  row density, typography or corner specification.
- Use surface and elevation roles to express structural hierarchy. Border,
  shadow, focus and selection must not independently stack decorations around
  the same control. Motion must use a shared purpose and timing, honor reduced
  motion, and never be required to discover or complete an action.

## State Composition

Domain state remains authoritative. Styling consumes it and never infers that an
operation succeeded, that a capability exists, or that a row is selected.
Selection belongs to the owning collection; pointer position and keyboard focus
are separate inputs, not alternative owners of selection.

| Input / transition | Design invariant |
| --- | --- |
| Hover enters or leaves | Only transient feedback changes; selection and layout do not |
| Selection/active view changes | Paint the shared selected treatment for the new owner; do not select its container |
| Selected item is also hovered/focused | Compose one surface; retain the appropriate keyboard cue without stacking fills |
| Press / operation starts | Show the actual pressed/pending state without changing control geometry or losing its label |
| Operation succeeds, fails or has uncertain outcome | Use the corresponding semantic feedback; uncertainty is never success and retry remains domain-owned |
| Control is disabled | Suppress activation and pressed feedback; preserve legibility and any still-valid selection/status |
| Appearance or density changes | Recompute presentation only; preserve identity, selection, expansion, viewing intent and action reachability |

Availability gates activation. Selection supplies persistent navigation feedback;
hover, focus and pressed feedback compose with it, while status remains legible.
The family's shared recipe defines this composition once, including applicable
selected-plus-hovered, selected-plus-disabled and pending-plus-focused cases.
Unspecified combinations must be resolved at that owner, not by whichever
selector happens to win.

Use the appearance contract's focus treatment for the control role: text-entry
focus, navigation focus and non-text control focus are not interchangeable.
Its no-left-rail, equal hover/selection surface, and container-focus rules apply
throughout Code. Use the interaction protocol for dismissal, focus return and
modal boundaries; visual reuse does not merge different keyboard semantics.

## Responsive And Input Contract

Density is an explicit family variant selected by shared layout policy. The same
viewport and role must not acquire unrelated geometry from independent pointer
queries. Input capabilities may change how actions are revealed, not whether an
available action or resource can be reached.

Every essential hover-only action needs an explicit keyboard and touch path:
a visible control or a clearly named command in an accessible menu. Hiding the
desktop action cluster is incomplete unless its capabilities remain available.
Validate this at initial narrow load as well as after resizing a wide view; a
wide-screen action performed beforehand must not be required to use mobile UI.

Distinguish visual bounds from hit bounds without overlapping adjacent targets.
Primary touch navigation can keep larger targets than dense detail rows under
their documented contracts. Neither difference permits a second menu design or
an inconsistent label style within the same family and density. Enlarging a
target must not stretch a neighboring row or mask its text. Responsive changes
must preserve virtual geometry, scroll position and the active interaction's
ownership, not only the apparent row height.

## Adoption And Exceptions

For a new control or a change to an existing one:

1. Identify the family, role, variant, state and existing peers before editing.
2. Reuse the shared owner. Where one does not exist, extract the smallest proven
   common specification from representative consumers with the implementation.
3. Migrate by family across affected product surfaces, not by giving each page a
   separate redesign. Remove superseded local overrides as consumers migrate.
4. Run the family and composed-interface gates below, including every consumer
   affected by a shared metric or variant change.

A deliberate difference must document its product reason, semantic scope,
owning component/recipe and acceptance case in the relevant canonical document.
A temporary migration exception also needs a tracked removal condition and
bounded consumer scope. A selector name, old screenshot, or “this page used to
look different” is not a product reason. Exception lists must not grow merely to
make a failing check pass.

This contract is a migration target, not a claim that all legacy controls already
conform. New work must not add another implementation of a known family. Existing
violations stay visible until migrated; recording the protocol or taking new
screenshots does not close them. Do not build an unused universal component
framework or bulk-normalize different roles to one pixel value.

## Acceptance Gates

Each adopted family must have executable ownership and rendering checks in the
normal repository checks, not only an optional manual gallery.

| Gate | Required evidence |
| --- | --- |
| Source ownership | Palette and metric definitions have one owner; consumers do not fork shared geometry, glyphs or state recipes. Check parsed declarations/structure where appropriate, not arbitrary pixel literals in all layout code. |
| Resolved equivalence | Real DOM consumers of the same family/variant/state match the expected shared specification and each other in font, line height, spacing, slots, radius, surface and hit bounds. Test against expected metrics as well as peer equality so two equally wrong controls cannot pass. |
| Behavioral equivalence | Same action feedback and keyboard/touch reachability; include disabled/pending/error states, disclosure, long labels, optional actions, nested/portalled surfaces, initial narrow load and width transitions. |
| Composed visual acceptance | Compare peers in production-shaped Code scenarios across Light/Dark/Paper, regular/compact layouts and supported mouse/touch/keyboard paths. Inspect simultaneous states, truncation, overlap and alignment; keep deterministic captures and exact fixture cleanup. |

Shared CSS variables do not prove resolved equivalence: inheritance and cascade
can override them. A screenshot of one component does not prove cross-page
consistency. Updating each page's baseline independently must not bless a
divergence. Browser/font environments may need separate pixel baselines, but the
semantic roles and CSS geometry remain comparable in the same environment.

Reports must distinguish protocol adoption, implemented family coverage, and
visual/interaction acceptance. List outstanding consumers and supported themes
or input paths not exercised; do not describe partial migration as unified Code.
