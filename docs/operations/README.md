# Operations

> Chinese version: [README.zh_cn.md](./README.zh_cn.md)

Operations documentation is for running and maintaining Farming after the first
task works.

## Common Operations

| Command | Purpose |
| --- | --- |
| `farming daemon` | Start Farming in the background. |
| `farming status` | Show whether Farming is running. |
| `farming url` | Print the current local URL. |
| `farming logs` | Read service logs. |
| `farming stop` | Stop Farming. |

Run `farming --help` for the installed version's complete command list.
Browser commands are disclosed gradually through `farming browser --help`.

## Deployment And Access

- [Security and trusted-network guidance](../../SECURITY.md)
- [Runtime dependency versions and update bindings](runtime-dependencies.md)
- [Connect an external CDP browser](../products/code/external-cdp-browser.md)

Use a VPN, SSH tunnel, HTTPS reverse proxy, or equivalent access control when a
remote connection crosses an untrusted network.

## Troubleshooting

Start with `farming status` and `farming logs`. If the service is stopped, run
`farming daemon`. If an Agent or Browser is unavailable, read the capability
message shown in Farming before changing settings.

When reporting a problem in [GitHub Issues](https://github.com/zhuwenzhuang/farming/issues),
include the Farming version, host platform, relevant log excerpt, and exact
user-visible error. Never include tokens or private repository content.
