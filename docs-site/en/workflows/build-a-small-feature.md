# Build a small feature

Small features are ideal for establishing a reliable Agent workflow: the scope is clear, feedback is fast, and completion is easier to judge.

## State the minimum state model

Before implementation, identify the authoritative owner, triggers, legal and illegal states, success/failure/cancellation/timeout endings, concurrency and reconnect behavior, and visible user feedback.

```text
Add an “Only this Project” filter for Agent completion notifications.
Keep the default unchanged. Store the setting in the backend and show an error
when saving fails. Test reads, failed writes, and refresh recovery, and update
the relevant user documentation.
```

## Ask for a plan

The plan should name authoritative documents, code boundaries, and verification—not merely a list of files. Provider differences belong in adapters; authoritative state belongs in the backend.

## Implement in stages

1. boundary and state contract;
2. backend behavior and tests;
3. frontend interaction and visible failure;
4. production-shaped verification;
5. user documentation.

Ask for short evidence after each stage before continuing.

## Control scope

If the Agent starts an unrelated refactor, ask for its direct relationship to the goal. A small feature should not introduce an abstraction that the current requirement does not prove necessary.

## Acceptance

Confirm that the normal path works, illegal input is rejected, loading and failure are visible, cancellation/timeout/reconnect cannot remain permanently transient, and tests and documentation agree with behavior.

Continue with [Verify and finish](./verify-and-finish).
