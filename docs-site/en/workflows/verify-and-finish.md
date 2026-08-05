# Verify and finish

An Agent saying “done” is a conclusion that still needs evidence. Confirm that real files, command results, and user-visible behavior support it.

## Read the final result

The final summary should state the result, change scope, verification performed, unverified work, and remaining risk. “Code changed” without verification is not enough.

## Inspect real files

Use Files to confirm that the authoritative source changed, unrelated formatting or refactoring was not included, boundaries and error paths are handled, and documentation describes behavior rather than implementation history.

## Inspect command results

Confirm exact commands and exit results in Chat activity or Terminal.

<ThemeImage light="/cn/assets/terminal-20260806.png" dark="/cn/assets/terminal-20260806-dark.png" alt="Verify command results in Terminal" />

Match verification to risk:

- copy or small documentation changes: build, link, or focused checks;
- module behavior: focused tests and type checking;
- lifecycle, recovery, or UI interaction: state-sequence tests and real UI verification;
- cross-Provider work: equivalent Provider-neutral acceptance.

## Handle failure and uncertainty

A timeout or disconnect is not a pass and should not automatically replay side-effecting commands. Read current state and artifacts before deciding whether a retry is safe.

## Send a final follow-up

```text
The implementation looks correct, but cancellation recovery is not covered.
Add that state-sequence test, run focused checks, and distinguish verified and
unverified results in the final summary.
```

## Organize the task

Give the Agent a searchable title, record residual risk, archive completed work, and update authoritative documentation for conclusions worth preserving.

Use [Search and History](../code/search-and-history) when you need to resume later.
