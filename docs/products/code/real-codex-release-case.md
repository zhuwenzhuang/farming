# Real Codex Cross-Interface Release Case

> Chinese version: [real-codex-release-case.zh_cn.md](./real-codex-release-case.zh_cn.md)

This is the blocking real-provider browser case for the Codex Terminal and ACP
Chat path shared by Farming Code and Farming CRT.

Run it once for every release candidate after deterministic checks pass:

```bash
npm run test:pre-release:codex-ui
```

## Contract

The case uses an isolated Farming Config and workspace with the locally
authenticated Codex runtime. Missing login, unavailable required capability,
runtime error, or failed assertion blocks the release. The test does not switch
to another model, renderer, Agent implementation, or runtime path to obtain a
pass.

The user journey must cross Code Terminal, Code Chat, CRT Chat, and CRT Terminal
while preserving one exact Codex Provider Session. It exercises real input,
structured Markdown, a long enough output to require scrolling, model/profile
changes, appearance changes, and repeated window resizing.

## Required Evidence

- the same Provider Session identity survives every Chat/Terminal and Code/CRT
  transition;
- Terminal input and Chat input each arrive exactly once;
- Chat preserves structured content rather than flattening it;
- Terminal checkpoints preserve the authoritative buffer and geometry through
  resize and interface changes;
- live profile changes reach the real Session;
- no terminal, renderer, replay, checkpoint, or protocol error reaches the page;
- failure artifacts include a trace and screenshots of the last stable states.

## Release Rule

Record the command result with the exact release revision and environment. A
pass proves only that revision, browser, Codex runtime, and model catalog. If a
required real capability changes, update this one case intentionally and review
the new cost and compatibility boundary; do not add an automatic fallback path.
