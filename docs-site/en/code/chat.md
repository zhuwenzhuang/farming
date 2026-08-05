# Chat

Chat arranges coding Agent messages, progress, and tool activity into a readable timeline. Use it to follow work, inspect evidence, and continue the conversation without losing context.

<ThemeImage light="/cn/assets/chat.png" dark="/cn/assets/chat-dark.png" alt="Structured Chat" />

## Read Agent progress

A Turn commonly contains your task, the Agent's plan or progress, file and command activity, and a final result with verification and remaining risk.

Progress can be collapsed. Read the result and verification first; expand detailed activity when you need an audit trail.

## Write a clear task

A useful first message usually states:

1. the desired result;
2. the allowed scope;
3. behavior that must remain unchanged;
4. required verification;
5. conditions that require the Agent to stop and ask.

Follow-ups should name a concrete gap, such as “add the cancellation test,” instead of only saying “keep improving.”

## Models and permissions

Providers expose different models, reasoning levels, service tiers, and permission controls. Farming shows only options supported by the current Provider and Session.

<ThemeImage light="/cn/assets/model-controls.png" dark="/cn/assets/model-controls-dark.png" alt="Model and runtime controls" />

Broader permissions reduce confirmation steps but increase possible impact. Use the minimum permissions that can complete the task, especially in unfamiliar repositories.

## Interrupt and follow up

If the direction is clearly wrong, stop the current Turn and send a more precise request. A network timeout does not prove that an operation failed; inspect files, Git state, and the current result before resending anything that could duplicate changes.

## Switch to Terminal

Switch to [Terminal](./terminal) when you need native CLI interaction or complete PTY output. Supported Providers keep the same Agent identity and Workspace.
