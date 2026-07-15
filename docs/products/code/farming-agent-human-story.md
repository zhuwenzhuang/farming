# Farming Code Human-Like Acceptance Story

> Chinese version: [farming-agent-human-story.zh_cn.md](./farming-agent-human-story.zh_cn.md)

This is the canonical ordinary-user walk for validating Farming Code. It starts from a cold browser, follows one project through Chat, Terminal, Files, History, and refresh, and checks the behavior a user can actually see.

## Story 1: Start Work In A Real Project

Goal: create one project Agent without needing to understand Main Agent.

1. Open the token URL at `/farming/`.
2. Confirm the workspace is connected and **New Agent** is enabled.
3. Choose Codex, Claude Code, OpenCode, Qoder, bash, or zsh.
4. Select an existing workspace and start the Agent.
5. Confirm the new row appears under that project and becomes active.

Expected:

- the first-use path begins with **New Agent**, not a mandatory Main Agent setup;
- coding Agent choices are enabled only when their executable/runtime is available;
- the Agent starts in the selected workspace;
- opening the same page again does not create a duplicate process.

## Story 2: Work In Structured Chat

Goal: ask a coding Agent to inspect and change a small feature while retaining evidence.

1. Start a supported coding Agent in **Chat**.
2. Send a request that requires reading a file and reporting what changed.
3. Watch the current process disclosure while the turn runs.
4. Expand one tool or file-change card, then collapse it again.
5. Send a follow-up after completion.

Expected:

- user messages, process entries, tools, and results keep their ACP order;
- the final result regains focus when the turn completes;
- tool details and exact historical patches remain expandable;
- internal heartbeat/context envelopes do not appear as user conversation;
- a message sent during an active turn is visibly queued and automatically dispatched when idle, unless the user discards it;
- IME composition, Enter/Shift+Enter, attachments, and draft history behave like an ordinary chat composer.

## Story 3: Change Runtime Settings Without Lying

Goal: change model or speed and know which runtime receives the change.

1. Open the model control for a compatible Codex session.
2. Drag to another model/reasoning point.
3. Toggle Fast or Ultra if the live capability advertises it.
4. Open and close **Advanced**.
5. Send the next message.

Expected:

- the drag thumb finishes at the selected point and the profile label agrees;
- opening Advanced preserves the same profile and the menu transition does not flash or jump;
- an unavailable Fast or Ultra control remains grey and disabled;
- ACP reconciles against the returned live Session snapshot;
- native Codex Terminal applies compatible model/Fast changes immediately and confirms them before the next message, not only on a later launch.

## Story 4: Switch Chat And Terminal Safely

Goal: inspect exact CLI behavior without losing the conversation.

1. With the Agent idle, switch from Chat to Terminal.
2. Confirm the same provider Session resumes in a real PTY.
3. Send terminal input and wait until the provider record is materialized.
4. Switch back to Chat.
5. Reload the browser.

Expected:

- Chat / Terminal changes the actual runtime rather than hiding one view;
- a fresh untouched Terminal may move directly into Chat;
- after Terminal input, a missing resumable provider record blocks the switch with an actionable error;
- a failed target runtime restores the original runtime;
- the active Agent and its output survive browser refresh while the Farming host remains alive.

## Story 5: Verify The Work Outside Chat

Goal: inspect files, review changes, and recover the task later.

1. Expand Files for the project.
2. Search a `path:line`, open the file, and show Git blame.
3. Open Changes or Review and inspect the exact diff.
4. Archive the Agent.
5. Search its title in History and restore it.

Expected:

- Files remains in the project scroll flow and does not create a nested project scrollbar;
- file operations stay inside the workspace root;
- blame, diff, and editor state remain stable while Agents continue producing output;
- History search can find older provider sessions beyond the first loaded browser page;
- ephemeral shell runtimes are destroyed on archive, while supported provider sessions keep truthful resume behavior.

## Story 6: Return From A Phone

Goal: check the same task away from the desktop.

1. Open the token URL at a 390px mobile width.
2. Open the project drawer and select the running Agent.
3. Read the latest result and send a short follow-up.
4. Open Files and inspect one location.
5. Refresh and confirm the same Agent remains visible.

Expected:

- the page has no document-level horizontal overflow;
- the drawer does not squeeze the focused Chat/Terminal area;
- the composer remains reachable with the software keyboard open;
- mobile does not add a separate web speech control when device dictation is available.

## Automated Coverage

The human walk is split across deterministic Playwright specs rather than one fragile end-to-end test:

- `tests/e2e/acp-human-cases.spec.ts`: structured ACP Chat behavior;
- `tests/e2e/model-matrix.spec.ts`: live ACP and Terminal model controls;
- `tests/e2e/terminal-regression-matrix.spec.ts`: PTY input, scrolling, selection, and recovery;
- `tests/e2e/additional-user-scenarios.spec.ts`: launch, files, History, and lifecycle flows;
- `tests/e2e/iphone-mobile-layout.spec.ts` and `tests/e2e/mobile-human-story.spec.ts`: mobile layout and intervention;
- `tests/e2e/review.spec.ts`: review data and interaction behavior.

Run focused coverage during iteration, then broaden before release:

```bash
npx playwright test tests/e2e/model-matrix.spec.ts --project=chromium
npx playwright test tests/e2e/acp-human-cases.spec.ts --project=chromium
npm run test:e2e:playwright
```

Fake coding executables provide deterministic CI coverage. Real Codex and Claude Code smoke tests remain explicit, low-volume, and isolated.
