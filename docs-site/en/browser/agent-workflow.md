# Agent Browser workflow

Supported command-capable Agents discover and operate Browser Resources through the CLI of the current Farming instance.

## Check capability

```bash
farming capabilities
farming browser capability
farming browser help workflow
```

Check current capability before creating a Resource. The existence of a command does not prove that the Browser runtime is available.

## Recommended sequence

```text
list → reuse or create → start → navigate → snapshot
     → act from Snapshot references → wait → verify
```

Observe before acting and verify after acting. Page changes can invalidate old element references and screenshots.

## Find Resources

```bash
farming browser list
```

Prefer a matching Browser already owned by the current Agent. Create another Resource only for a separate page or Profile.

## Progressive help

```bash
farming browser help navigation
farming browser help interaction
farming browser help inspection
farming browser help debugging
farming browser help files
```

Read a command's `--help`, or `describe <command> --json`, only when exact parameters are needed.

## Act and verify

- Wait for an explicit page state after navigation.
- Prefer structured Snapshots for element location.
- Confirm that click and fill targets are unique.
- Observe again after page updates.
- Do not replay a submit, send, or delete operation when a timeout leaves the outcome uncertain.

## File boundary

Uploads and downloads remain inside the Browser's Project Workspace. Do not escape through path traversal or silently overwrite existing downloads.

## User intervention

For login, CAPTCHA, payment, sensitive data, or irreversible confirmation, stop at a clear point and request user control or explicit authorization. Observe fresh state after control returns.
