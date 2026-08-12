# Understand a codebase

In an unfamiliar repository, ask the Agent to build a verifiable structural map before changing anything. Farming keeps explanations and real evidence together through Files, Chat, and Terminal.

## Start with a question

Do not only say “analyze this repository.” State what you need to understand:

```text
Explain the main path from a user request to backend Session creation.
Do not modify files. List key entry points, state owners, major failure paths,
and related tests, and say which files you actually read.
```

A precise scope makes the answer easier to verify.

## Structure before detail

Ask the Agent to:

1. read repository entry points, development documentation, and related tests;
2. describe module relationships and important boundaries;
3. explain a small number of authoritative files in depth;
4. identify uncertainties that still require verification.

Collapse routine activity in Chat while keeping important file and command evidence.

<ThemeImage light="/cn/assets/chat.png" dark="/cn/assets/chat-dark.png" paper="/cn/assets/chat-paper.png" alt="Read structured Agent progress" />

## Verify with Files

Open cited files and check that paths are correct, code actually owns the described responsibility, documentation and tests support the conclusion, and historical implementation has not been mistaken for current behavior.

If a conclusion comes only from a name or comment, ask the Agent to trace callers, state sources, or tests.

## Verify with Terminal

When startup commands, test scope, or generation behavior matters, ask for the smallest read-only or verification command first—not an immediate full-repository build.

## Produce a reusable result

A durable explanation should identify the core product path, authoritative state owners, boundaries for Provider or platform differences, visible failure behavior, and tests that support the model.

If the understanding will guide future development, update the authoritative document instead of leaving it only in Chat history.
