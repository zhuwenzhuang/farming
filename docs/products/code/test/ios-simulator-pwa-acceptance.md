# iOS Simulator PWA Acceptance

> Chinese version: [ios-simulator-pwa-acceptance.zh_cn.md](./ios-simulator-pwa-acceptance.zh_cn.md)

This harness verifies Farming Code as a real iOS standalone Web App. It uses
Apple XCUITest to open Mobile Safari, select **Add to Home Screen**, launch the
installed icon from SpringBoard, and exercise the resulting
`com.apple.webapp` process. It does not mock `navigator.standalone`, use a
Playwright device profile as a substitute, or depend on Computer Use.

## Run

Requirements:

- macOS with Xcode and an available iPhone Simulator;
- repository dependencies installed;
- the Simulator has completed the ordinary first-launch Safari prompts.

Run the complete build, isolated fake-Agent server, installation, acceptance,
artifact export, and cleanup flow:

```bash
npm run test:e2e:ios-pwa
```

Set `FARMING_IOS_SIMULATOR_UDID` to select a specific Simulator. Otherwise the
runner uses a booted iPhone, or boots an available iPhone 16 Pro. Set
`FARMING_IOS_PWA_OUTPUT_DIR` to choose a new, non-existing artifact directory.

The command succeeds only when all three product assertions pass. A non-zero
exit after an `IOS_PWA_EVIDENCE` line is a product regression; a failure before
that line is classified as a harness or environment blocker.

## State Model

The runner owns one isolated Config directory, one loopback port, one fake ACP
Agent and workspace, one uniquely named Home Screen Web App, and the XCUITest
host/runner apps.

1. Build the current source and start the backend with fake executables and the
   fake ACP adapter.
2. Create the fixture Agent and wait for authoritative ACP idle state.
3. XCUITest installs the manifest through Safari's public share-sheet flow.
4. Every scenario activates SpringBoard, launches the icon, and verifies the
   real standalone process. Launch has three bounded attempts; exhausting them
   fails before product evidence rather than being reported as a layout result.
5. The runner exports the `.xcresult`, named screenshots, summary, logs, and
   run metadata.
6. In `finally`, delete the exact fixture Agent, hard-kill the owned server
   process group, uninstall only newly observed WebKit PushBundle IDs and the
   two known harness bundle IDs, remove only the temporary directories created
   by this run, and verify that the selected port closed.

The three scenarios cover:

- excessive blank space below the resting standalone Composer;
- the Start New Agent dialog entering the iOS status/Dynamic Island region or
  clipping its heading and first provider row;
- a focused, busy ACP Composer with a queued message whose Add, model, and
  active-turn controls must remain above iOS input UI and hittable.

The compact layout has one viewport owner: an installed standalone app uses the
full screen layout height while the software keyboard is absent, and the
shrunken visual viewport while the keyboard is present. Safe-area clearance is
then applied once by the owning mobile surface.

## Artifacts And Failure Classification

Each run writes a new ignored directory under `.tmp/ios-pwa-acceptance/` by
default. It contains:

- `FarmingPWAAcceptance.xcresult`;
- `screenshots/01-*.png`, `02-*.png`, and `03-*.png` for scenarios that reached
  capture;
- `summary.json`, `xcodebuild.log`, `server.log`, `run.json`, and
  `cleanup.json`;
- the complete exported XCUITest attachments.

An `IOS_PWA_EVIDENCE` line means a scenario reached its product geometry and
interaction assertions. A failure before that line is a harness or environment
blocker and must not be reported as a product regression. Keep the `.xcresult`
and screenshot for diagnosis, but do not commit generated artifacts.

## Known Limits

- The checked-in selectors cover the English iOS 18 Safari and Farming labels.
- This is a portrait iPhone Simulator gate; physical-device signing and iPad
  behavior are outside its scope.
- A pristine Simulator may require a one-time manual dismissal of Apple's
  first-launch Safari screens before unattended runs are possible.
