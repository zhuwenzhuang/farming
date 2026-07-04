# Security Policy

> Chinese version: [SECURITY.zh_cn.md](./SECURITY.zh_cn.md)

Farming controls real terminals and AI coding-agent processes on the target machine. Treat every deployment as access to that machine.

## Supported Versions

The active development branch and the latest published release receive security fixes.

## Deployment Guidance

- Run Farming on trusted development machines and trusted networks.
- Do not expose Farming directly to the public internet without an additional security layer such as VPN, SSH tunnel, HTTPS reverse proxy, or network ACLs.
- Keep token authentication enabled outside trusted local development.
- Use `FARMING_DISABLE_AUTH=1` only for local development on a trusted machine.
- Install and configure Codex / Claude Code permissions according to their own security model; Farming hosts their CLI sessions but does not replace their permission system.
- Do not commit real tokens, private `.env` files, internal hosts, personal machine paths, or private screenshots.

## Reporting A Vulnerability

Please report security issues privately to the maintainers instead of opening a public issue with exploit details.

Maintainers:

- [zhuwenzhuang](https://github.com/zhuwenzhuang)
- [l4wei](https://github.com/l4wei)

When reporting, include the affected version or commit, deployment mode, reproduction steps, and the expected impact.
