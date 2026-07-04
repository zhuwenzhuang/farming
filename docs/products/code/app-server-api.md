# Farming Code App-Server API

Chinese version: [app-server-api.zh_cn.md](./app-server-api.zh_cn.md)

Farming exposes a thin app-server API bridge for Codex. The bridge is intentionally backend-only for now: it does not replace the terminal UI, and it does not change Farming's existing runtime session ownership or main-page membership rules.

## Scope

- Provider support is limited to `codex`.
- The bridge speaks Codex app-server JSON-RPC over `ws://`, `wss://`, or explicit `unix:///absolute/path.sock` endpoints.
- Farming manages the app-server `initialize` request and `initialized` notification.
- Client request methods, server request methods, and notification method names are exposed as metadata so the frontend can build structured Codex views incrementally.

Start a local Codex app-server for development:

```bash
codex app-server --listen ws://127.0.0.1:4500
```

Then either set:

```bash
FARMING_CODEX_APP_SERVER_ENDPOINT=ws://127.0.0.1:4500
```

or pass `endpoint` in each API request body or query string.

## Endpoints

- `GET /api/app-server` lists supported providers and method metadata.
- `GET /api/app-server/codex` returns Codex bridge metadata plus connection status.
- `POST /api/app-server/codex/connect` opens and initializes the Codex app-server connection.
- `POST /api/app-server/codex/disconnect` closes Farming's bridge connection.
- `POST /api/app-server/codex/rpc` forwards one Codex app-server JSON-RPC request.
- `GET /api/app-server/codex/events` streams bridge events as Server-Sent Events.
- `POST /api/app-server/codex/server-requests/:requestId/resolve` answers an app-server request from Codex.
- `POST /api/app-server/codex/server-requests/:requestId/reject` rejects an app-server request from Codex.

Example RPC body:

```json
{
  "endpoint": "ws://127.0.0.1:4500",
  "method": "model/list",
  "params": {
    "cursor": null,
    "limit": 20,
    "includeHidden": true
  }
}
```

App-server WebSocket auth tokens can be passed with `x-app-server-auth-token`, `Authorization: Bearer ...`, or the JSON body field `authToken`. Do not persist these tokens in Farming settings.

## Product Boundary

The first useful UI layer should read app-server events such as `turn/started`, `turn/plan/updated`, `turn/diff/updated`, `item/fileChange/patchUpdated`, `item/agentMessage/delta`, and approval server requests. The raw terminal remains the compatibility and debugging surface until the structured UI is good enough to take over daily Codex supervision.
