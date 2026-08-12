# Find and fix a problem

A good fix builds an evidence chain from the observable symptom to the root cause and verification—not merely a quick file edit.

## Describe the symptom

Include what the user did, expected and actual results, reproducibility, relevant logs or screenshots, and behavior that must remain unchanged.

```text
History search sometimes keeps the previous result after a second query.
Reproduce it and identify the authoritative state source before fixing it.
Do not hide the issue with a longer fixed wait. Add a deterministic test for
out-of-order requests and run focused verification.
```

## Reproduce first

Ask for the smallest reproduction. If it cannot be reproduced, the Agent should not edit the most suspicious file based only on a guess.

A useful reproduction states the trigger, current state, incorrect output or UI, and the difference between success and failure.

## Narrow the root cause

Use Files to search state owners, request entry points, and existing tests. Distinguish where the symptom appears, where incorrect state is written, and which boundary owns concurrency, cancellation, or recovery.

## Make the smallest direct fix

The change should correspond to the root cause and preserve unrelated behavior. For concurrency, timeout, and reconnect issues, prove both safety and liveness: reject illegal state and give transient state a bounded terminal path.

## Prove the fix

Run the regression test, focused checks for the affected module, and a production-shaped scenario when risk requires it. Report exact commands, results, and gaps, then inspect Files or Git state for unrelated changes.
