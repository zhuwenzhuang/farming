# Farming Computer

> Chinese version: [computer-use.zh_cn.md](./computer-use.zh_cn.md)

Farming Computer is an optional, experimental full-desktop control surface. It
complements Farming Browser: use Browser for fast, structured web automation;
use Computer when a task must see and operate the rendered desktop, browser
chrome, native dialogs, or another Linux application.

## Prepare

Farming does not ship a desktop image and never pulls one during install,
update, or Server startup. The user explicitly prepares Computer in
**Plugins → Computer**. Farming then pulls the reviewed upstream
`trycua/xfce-cua` image at the exact digest shown by the plugin and verifies the
pinned Cua Driver version before Computer can be enabled.

The same extension also owns the Docker boundary for Browser's optional
Isolated Browser source. That path is prepared separately in
**Plugins → Browser** from the pinned upstream `trycua/cuabot` image. It exposes
Chromium's CDP only on loopback and hands it privately to Farming's existing
`agent-browser` runtime; it does not add a second Browser automation path.
The Browser container is separate from the full Computer container because the
reviewed desktop image does not include Chromium. They share only the Computer
extension's verified Docker ownership boundary.

Some older Docker Engines cannot run the image with their default seccomp
profile. If the probe reports this exact incompatibility, disable Computer,
enable the explicit compatibility option, prepare again, and then enable the
plugin. Farming does not retry with a weaker sandbox silently.

## Ownership And Lifecycle

An Agent opens one isolated Computer. Its stable Farming Agent record owns the
Resource and exact Docker container; the Project remains the workspace
isolation boundary. Different Agents never share the container, desktop,
session, or Viewer password.

- Chat/Terminal switches and permission restarts retain the Computer.
- Stopping or archiving the Agent stops the container but retains the Resource.
- Deleting the Agent removes its exact owned container and Resource.
- Disabling the plugin stops Computers without deleting their retained state.

Farming verifies the container id and ownership labels before every destructive
operation. The container exposes noVNC only on loopback; the authenticated
Farming Server proxies it to the Viewer.

## Agent And Human Control

ACP Agents receive the complete pinned `computer_*` tool catalog when Computer
is enabled at their Session boundary. Terminal Agents use the same contract
through `farming computer`; run `farming computer help workflow` for the
progressive CLI path.

Control has one explicit owner. While the Agent owns it, the user sees a
read-only live desktop. **Take control** reloads the Viewer into an interactive
epoch and blocks Agent actions. **Return to Agent** closes that epoch, and the
Agent must obtain a fresh desktop, browser, window, or accessibility-tree
observation before acting; metadata-only reads do not clear that fence.
Control changes and lifecycle removal close new admissions and drain already
accepted actions before advancing the epoch or removing the container. Farming
admits only tools declared by its pinned Cua manifest, and a stopped, exited,
failed, dead, or archived Agent cannot restart its Computer. A timed-out action
has an uncertain outcome and is never replayed automatically.

The initial runtime is intentionally limited to the pinned Linux Cua Driver
contract. It is not a general third-party Computer provider API.
