# Frequently asked questions

## Is Farming a cloud service?

No. Farming is open source and self-hosted. Agent processes, Terminals, and Project files run on your Farming Host.

## Do I still need Provider accounts?

Yes. Codex, Claude Code, OpenCode, and other Providers keep their own authentication and terms. Farming does not provide or bypass Provider accounts.

## Does closing the browser stop an Agent?

No. The backend and Agent continue on the Host. Reopen the address to continue.

## Can I use a phone?

Yes. Phones are best for state checks, Chat reading, and short follow-ups. Complex Terminal work and broad editing fit a larger screen.

## Can I expose Farming directly to the internet?

It is not recommended. Use a VPN, SSH tunnel, HTTPS reverse proxy, or equivalent control. Protect authenticated URLs as credentials.

## What is the difference between Chat and Terminal?

Chat structures progress and results. Terminal provides a real PTY and native CLI interaction. Supported Providers can switch within the same Agent.

## Does Farming Browser use my signed-in state?

It depends on the Browser source and Profile. Give an Agent only accounts required by its Project. Agents do not share Cookies and Storage by default.

## Why is a Language Server action missing?

Language Server support is enabled by default, but available actions depend on the language, Project, and active Server. Open **Plugins → Farming** to see whether that Server is running, available, installable, or missing.

Computer Use remains experimental and appears only when prerequisites such as a remote Docker desktop are satisfied.

## Does Farming support Windows?

Public support currently covers macOS and Linux. Other platforms have not reached the same installation, PTY, recovery, and Browser validation standard.

## Where is the version?

See the lower-left corner or **Settings → Updates**. Public history is on [GitHub Releases](https://github.com/zhuwenzhuang/farming/releases).
