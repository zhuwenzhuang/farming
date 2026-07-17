# Real Codex Cross-Skin Release Case

> Chinese version: [real-codex-release-case.zh_cn.md](./real-codex-release-case.zh_cn.md)

This is the blocking, human-like browser case for the terminal and structured Chat path shared by Farming Code and Farming CRT. Run it once for every release candidate after the fast source checks and focused deterministic Playwright tests pass:

```bash
npm run test:pre-release:codex-ui
```

The command uses the locally authenticated real Codex CLI, one Chromium worker, an isolated Farming config directory, and a temporary workspace. Its test-only launcher disables the CLI startup update check for every Terminal start and resume without changing the user's global Codex configuration. It is intentionally absent from the default fake-Agent E2E suite because it consumes a real model allocation and validates external CLI integration. A missing login, unavailable required model, runtime error, or failed assertion blocks the release; the case does not select another renderer, model flow, Agent implementation, or test branch.

## State Chain

The test has one ordered state chain:

```text
Code Terminal
  -> live low-cost model switch
  -> xterm command-line prompt
  -> Code Composer prompt
  -> multi-page mixed-format output
  -> shrink and expand window drags
  -> Code Chat
  -> shrink and expand window drags
  -> dark appearance
  -> shrink and expand window drags
  -> Settings: Farming CRT
  -> CRT MSG
  -> shrink and expand window drags
  -> CRT Terminal
  -> shrink and expand window drags
  -> terminal input
  -> CRT MSG
  -> live model change
  -> MSG input
  -> shrink and expand window drags
  -> CRT Terminal
  -> final resize at the normal viewport
```

Every Chat / Terminal transition must retain the exact Codex provider session id. Every transient wait is bounded. A failed transition ends the case instead of restoring or trying an alternate runtime.

## Required Evidence

The generated conversation includes headings, paragraphs, inline code, a URL, unordered and ordered lists, task items, a quote, a table, JSON, YAML, diff, shell, CJK text, and six numbered output pages. Short unique anchors prove that both terminal input routes and both CRT input routes reached the same provider session.

The case checks:

- Code and CRT render the required content before and after every transition;
- native xterm paste in CRT inserts the Terminal prompt exactly once before submission;
- Code Chat reconstructs the expected Markdown semantics, not only flat text;
- Code Terminal reports the WebGL renderer and no terminal recovery error;
- continuous Code window drags preserve the multi-page buffer and commit one final geometry per drag direction;
- CRT terminal resize samples preserve the normal-size anchor until the resize settles, preserve a required page-tail anchor while expanding from the compact layout, restore the final output anchor at normal size, never enter checkpoint recovery, and never show a WebGL failure;
- the final terminal geometry returns to the normal viewport;
- the low-cost model switch and the later CRT model setting both reach the live session, and the final Terminal reports the recorded-versus-resumed model transition truthfully;
- no terminal, WebGL, checkpoint, replay, or renderer error reaches the page error stream.

Playwright retains a trace on failure. The case also attaches screenshots for the important Code Terminal, dark Chat, CRT MSG, and CRT Terminal states, plus a JSON evidence record containing the provider session id, selected models, anchors, final Agent id, and final viewport.

## Release Rule

Record the command result with the release candidate revision. A passing result proves only that revision, machine, browser, Codex CLI, and model catalog. If the real catalog removes `gpt-5.6-luna` or `gpt-5.4-mini`, update this single case intentionally and review the new cost and capability choice; do not add a second automatic model path.
