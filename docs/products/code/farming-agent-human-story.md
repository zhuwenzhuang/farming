# Farming Agent Human Story

> Chinese version: [farming-agent-human-story.zh_cn.md](./farming-agent-human-story.zh_cn.md)

This document is the canonical human-like story for validating Farming as an Agent workspace. It focuses on the experience a user should be able to complete from a cold start, and then again after reopening the page.

## Story 1: Start From Zero

Goal: use Farming to start a Main Agent and ask it to implement a tiny feature.

1. Open `/farming/`.
2. The first screen should offer `Start Main Agent` without asking for a Main Agent path.
3. Choose `Codex`.
4. The left sidebar should show one live Main Agent.
5. Type a feature request in the composer, for example:

   ```text
   add greeting to app.js
   ```

6. If Codex is currently working, the message should appear as a queued follow-up instead of being sent directly.
7. Click `Steer` to send queued follow-ups into the active agent terminal.
8. The terminal should receive the message and continue streaming output.

Expected behavior:

- The page opens with WebSocket connected and enabled agent choices.
- The composer sends `\r` to the terminal when a message is actually dispatched.
- When the agent is busy, messages queue in a visible pending follow-up card.
- Clicking `Steer` flushes queued messages.
- No duplicate agent should appear when reopening or re-clicking an already resumed session.

## Story 2: Reopen And Continue

Goal: close or reload the browser and continue work without losing the active agent.

1. Start a Codex agent.
2. Send or queue a follow-up.
3. Reload the page.
4. The same agent row should still be present and selected.
5. Type another follow-up.

Expected behavior:

- The active agent survives browser reload as long as the Farming server is still running.
- Composer controls remain enabled for the selected agent.
- A busy Code-style agent still queues follow-ups until the user clicks `Steer`.

## Story 3: Existing Project Development

Goal: open an existing project and complete a real terminal-backed edit.

1. Start the Main Agent.
2. Click `New Agent`.
3. Choose `bash`.
4. Pick an existing project directory.
5. Run a small project edit command in the composer, for example appending a smoke line to `app.js`.
6. Confirm the file changed.

Expected behavior:

- New project agents start in the chosen project directory.
- Shell terminal output keeps the controlled prompt format:

  ```text
  [user@host ~/project]
  $
  ```

- ANSI color escape sequences are preserved so the terminal renderer can display prompt color.

## Story 4: Read Older Terminal Output

Goal: inspect earlier terminal output while an agent is still producing new text.

1. Open a running agent terminal.
2. Scroll upward to read older output.
3. Let the agent print more output.
4. Click the small down-arrow button only when ready to jump back to the latest output.

Expected behavior:

- New output must not force the viewport back to the bottom while the user is reading older lines.
- A small jump-to-latest button appears when the terminal is no longer following output.
- Clicking the button scrolls to the bottom and resumes following new output.

## Automated Test

The Playwright spec `tests/e2e/human-story.spec.ts` covers this story with a fake Codex binary:

- `starts a Code-style agent, queues follow-ups while busy, and survives reopening the page`
- `keeps terminal scroll anchored until the user jumps to latest output`
- `opens an existing project agent and completes a real file edit through the terminal`

The Playwright server defaults `FARMING_CODEX_BIN` to `tests/e2e/fixtures/fake-codex`, so automated tests do not launch a real Codex session.

Run:

```bash
npx playwright test tests/e2e/human-story.spec.ts
```

## Issues Found While Walking The Story

- `/farming/` can load static HTML while still feeling unusable if WebSocket is not connected; the story checks enabled agent choices, not just HTTP 200.
- Recent Codex Desktop sessions were written by Codex `0.142.x`, while PATH could resolve an older global `codex` binary. Farming now records Codex session `cli_version`, prefers a compatible Codex executable, and returns a clear update error instead of launching an incompatible resume.
- `codex resume` now includes the original session cwd via `-C <cwd>`, so workspace-specific resume and hooks behavior match the original project.
- Resolving `bash` to `/bin/bash` used to bypass Farming's controlled prompt setup. Shell detection now uses the executable basename, preserving brackets and colors.
