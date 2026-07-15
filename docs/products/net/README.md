# Farming Net

> Chinese version: [README.zh_cn.md](./README.zh_cn.md)

Farming Net is a small, token-protected directory for Farming deployments. Run it on one trusted host, register the Farming URLs you already operate, and use one stable page to find local, remote, intranet, or tunneled environments. An enrolled target can accept a short-lived signed pass from the portal, so one portal login opens every Farming instance the owner has explicitly trusted.

It is deliberately separate from Farming Code and Farming CRT. Farming Net does not start Agents, proxy terminal traffic, merge settings, or copy target tokens into the registry. Each card opens the registered target in a new tab, and that target continues to enforce its own network policy and explicitly configured portal trust.

## Start

```bash
FARMING_NET_PORT=6693 \
FARMING_NET_BASE_PATH=/farming-net \
npm run start:net
```

The default config directory is `~/.farming-net`. On first start, Farming Net creates:

- `.session-token`: the dedicated portal token, reused across restarts;
- `instances.json`: the private deployment registry;
- `signing-private-key.pem`: the portal's Ed25519 signing key, never copied to a target;
- `signing-public-key.pem`: the public key used to enroll a target;
- `farming-net-server.json`: the current process and listener metadata.

Use `FARMING_NET_CONFIG_DIR` to isolate another registry, `FARMING_NET_TOKEN` to supply a fixed portal token, or `FARMING_NET_DISABLE_AUTH=1` only for a trusted local smoke test. The default listener is `0.0.0.0:6693` at `/farming-net/`.

## Registry

Edit `~/.farming-net/instances.json` and refresh the page; the server reloads it on every registry request, so ordinary link changes do not require a restart.

```json
{
  "version": 1,
  "title": "Farming Net",
  "subtitle": "All deployed Farming workspaces, one click away.",
  "instances": [
    {
      "id": "local-workstation",
      "name": "Local workstation",
      "description": "Farming on this browser's device",
      "platform": "macOS",
      "pinned": true,
      "endpoints": [
        {
          "label": "Open locally",
          "url": "http://127.0.0.1:6694/farming/",
          "scope": "this-device",
          "primary": true
        }
      ]
    },
    {
      "id": "remote-linux",
      "name": "Remote Linux",
      "owner": "Example owner",
      "platform": "Linux",
      "federated": true,
      "endpoints": [
        {
          "label": "Open remote Farming",
          "url": "https://dev-host.example/farming/",
          "scope": "remote",
          "primary": true
        }
      ]
    }
  ]
}
```

Instance IDs must use letters, numbers, `.`, `_`, or `-`. Endpoint scope is one of `this-device`, `intranet`, `remote`, or `tunnel`. Only HTTP(S) URLs are accepted. User info, query strings, and fragments are removed before the registry reaches the browser, so do not use endpoint URLs as a place to store target tokens.

When `federated` is `true`, the card first calls the portal. The portal creates a target-bound, Ed25519-signed pass with a 30-second lifetime and then redirects the browser to the target. Without `federated`, the card remains an ordinary direct link.

## Enroll A Target

The target must run a Farming build that supports Farming Net passes. Create `~/.farming/farming-net-trust.json` on that target using the portal issuer from `~/.farming-net/farming-net-server.json` and the contents of `~/.farming-net/signing-public-key.pem`:

```json
{
  "version": 1,
  "audience": "remote-linux",
  "issuers": [
    {
      "id": "fnet_REPLACE_WITH_PORTAL_ISSUER",
      "name": "My Farming Net",
      "publicKey": "-----BEGIN PUBLIC KEY-----\nREPLACE_WITH_PORTAL_PUBLIC_KEY\n-----END PUBLIC KEY-----\n"
    }
  ]
}
```

The trust `audience` must exactly match the instance `id` in the portal registry. Trust is opt-in per target; copying only the public key does not expose the signing key or the target's normal Farming token. Trust-file changes are reloaded on each pass verification.

After a valid pass reaches the target, Farming sets its normal `farming_token` HttpOnly cookie and immediately redirects to the same URL without the pass. A pass is valid for at most 60 seconds, defaults to 30 seconds, is scoped to one target, and can be exchanged only once per running target process. The normal Farming token never travels through the portal, registry API, or link URL.

## Security Boundary

Treat the portal registry as private operational configuration and do not commit real hostnames, addresses, or tokens. Farming Net has an independent cookie named `farming_net_token`, scoped to its base path, so it does not overwrite a Farming instance cookie on the same host.

For federated instances, the portal token is a master capability for every target that trusts its signing key. Keep it private, rotate it if it is disclosed, and expose the portal only through a trusted network, VPN, SSH tunnel, or HTTPS reverse proxy. Removing an issuer from a target trust file revokes future portal access to that target without changing the target's own token. A failed browser reachability probe is shown as “Not verified,” because browser network policy can block a probe even when the link itself is valid.
