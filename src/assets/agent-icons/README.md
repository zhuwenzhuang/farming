# Agent icon assets

Brand SVGs are grouped by Agent and visual treatment:

- `color/`: source artwork with its brand colors.
- `dark/`: theme-specific artwork whose neutral parts remain visible on dark backgrounds.
- `monochrome/`: artwork driven by `currentColor`, suitable for contextual or theme-aware UI.

`claude.svg` and `claude-code.svg` are intentionally separate assets. Codex retains only monochrome artwork. OpenCode, Qoder, and Zsh select their dark assets automatically in dark mode. `AgentLaunchIcon` uses color artwork by default where available, including the Claude Code mark for the `claude` CLI; callers can request `variant="monochrome"` for a restrained contextual treatment.
