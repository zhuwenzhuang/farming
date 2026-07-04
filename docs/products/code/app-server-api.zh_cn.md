# Farming Code App-Server API

English version: [app-server-api.md](./app-server-api.md)

Farming 现在提供一层很薄的 Codex app-server API 桥接。它目前只在后端生效：不替代 terminal UI，也不改变 Farming 现有的 runtime session 归属和主页面 membership 规则。

## 范围

- provider 先只支持 `codex`。
- 桥接层通过 `ws://`、`wss://`，或显式 `unix:///absolute/path.sock` 连接 Codex app-server JSON-RPC。
- Farming 负责 app-server 的 `initialize` request 和 `initialized` notification。
- client request、server request、notification 的方法名会作为 metadata 暴露，方便前端逐步构建结构化 Codex 视图。

本地开发时可以先启动 Codex app-server：

```bash
codex app-server --listen ws://127.0.0.1:4500
```

然后设置：

```bash
FARMING_CODEX_APP_SERVER_ENDPOINT=ws://127.0.0.1:4500
```

或者在每次 API 请求的 body / query string 里传 `endpoint`。

## 接口

- `GET /api/app-server` 列出支持的 provider 和方法 metadata。
- `GET /api/app-server/codex` 返回 Codex bridge metadata 和连接状态。
- `POST /api/app-server/codex/connect` 打开并初始化 Codex app-server 连接。
- `POST /api/app-server/codex/disconnect` 关闭 Farming 的桥接连接。
- `POST /api/app-server/codex/rpc` 转发一次 Codex app-server JSON-RPC request。
- `GET /api/app-server/codex/events` 以 Server-Sent Events 流式输出 bridge events。
- `POST /api/app-server/codex/server-requests/:requestId/resolve` 回答 Codex 发来的 app-server request。
- `POST /api/app-server/codex/server-requests/:requestId/reject` 拒绝 Codex 发来的 app-server request。

RPC body 示例：

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

如果 Codex app-server WebSocket 开启了认证，可以通过 `x-app-server-auth-token`、`Authorization: Bearer ...`，或 JSON body 字段 `authToken` 传 token。不要把这些 token 持久化进 Farming settings。

## 产品边界

第一层有价值的 UI 应该先消费 `turn/started`、`turn/plan/updated`、`turn/diff/updated`、`item/fileChange/patchUpdated`、`item/agentMessage/delta` 以及 approval server requests。raw terminal 继续作为兼容和调试界面，直到结构化 UI 足够好，可以承担日常 Codex 监督。
