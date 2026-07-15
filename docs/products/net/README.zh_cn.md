# Farming Net

> English version: [README.md](./README.md)

Farming Net 是一个轻量、带 Token 鉴权的 Farming 部署门户。把它运行在一台可信主机上，将已经部署好的 Farming URL 登记进去，就可以从一个稳定页面找到本机、远程、内网或隧道环境。目标 Farming 完成显式登记后，可以接受门户签发的短时通行证，因此所有者登录一次门户，就能打开自己已经授权的全部 Farming。

它与 Farming Code、Farming CRT 是彼此独立的产品面。Farming Net 不启动 Agent、不代理终端流量、不合并设置，也不会把目标 Token 复制进注册表。每张卡片会在新标签页打开登记的目标，目标环境仍然执行自己的网络策略和显式配置的门户信任。

## 启动

```bash
FARMING_NET_PORT=6693 \
FARMING_NET_BASE_PATH=/farming-net \
npm run start:net
```

默认配置目录是 `~/.farming-net`。第一次启动时会创建：

- `.session-token`：门户独立使用、重启时复用的 Token；
- `instances.json`：私有部署注册表；
- `signing-private-key.pem`：门户的 Ed25519 签名私钥，绝不能复制到目标；
- `signing-public-key.pem`：登记目标时使用的公钥；
- `farming-net-server.json`：当前进程和监听地址元数据。

可以用 `FARMING_NET_CONFIG_DIR` 隔离另一套注册表，用 `FARMING_NET_TOKEN` 指定固定门户 Token。`FARMING_NET_DISABLE_AUTH=1` 只允许用于可信本机冒烟。默认监听 `0.0.0.0:6693`，入口是 `/farming-net/`。

## 注册表

编辑 `~/.farming-net/instances.json` 后刷新页面即可。Server 会在每次读取注册表时重新加载文件，所以普通链接变更不需要重启。

```json
{
  "version": 1,
  "title": "Farming Net",
  "subtitle": "所有已经部署的 Farming，一个入口。",
  "instances": [
    {
      "id": "local-workstation",
      "name": "本机环境",
      "description": "当前浏览器所在设备上的 Farming",
      "platform": "macOS",
      "pinned": true,
      "endpoints": [
        {
          "label": "从本机打开",
          "url": "http://127.0.0.1:6694/farming/",
          "scope": "this-device",
          "primary": true
        }
      ]
    },
    {
      "id": "remote-linux",
      "name": "远程 Linux",
      "owner": "示例所有者",
      "platform": "Linux",
      "federated": true,
      "endpoints": [
        {
          "label": "打开远程 Farming",
          "url": "https://dev-host.example/farming/",
          "scope": "remote",
          "primary": true
        }
      ]
    }
  ]
}
```

Instance ID 只能使用字母、数字、`.`、`_` 或 `-`。Endpoint Scope 可选 `this-device`、`intranet`、`remote`、`tunnel`。只接受 HTTP(S) URL；注册表进入浏览器前会移除用户信息、Query 和 Fragment，因此不要把目标 Token 存在 Endpoint URL 中。

当 `federated` 为 `true` 时，卡片先访问门户。门户签发一枚绑定目标、Ed25519 签名、有效期 30 秒的通行证，再把浏览器重定向到目标。没有开启 `federated` 的卡片仍然只是普通直达链接。

## 登记一个目标

目标需要运行支持 Farming Net 通行证的 Farming 版本。在目标机器创建 `~/.farming/farming-net-trust.json`，其中 Portal Issuer 来自门户的 `~/.farming-net/farming-net-server.json`，公钥内容来自 `~/.farming-net/signing-public-key.pem`：

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

Trust 文件里的 `audience` 必须与门户注册表中的 Instance `id` 完全一致。每个目标都需要主动信任门户；仅复制公钥不会泄露门户私钥，也不会暴露目标原有的 Farming Token。每次校验通行证时都会重新读取 Trust 文件。

目标收到有效通行证后，会设置自己正常使用的 `farming_token` HttpOnly Cookie，并立刻重定向到不含通行证的同一个 URL。通行证最长不超过 60 秒，默认 30 秒，只对一个目标生效，并且在目标进程的一次运行期间只能兑换一次。目标原有 Farming Token 不会经过门户、注册表 API 或链接 URL。

## 安全边界

真实注册表属于私有运维配置，不要把真实主机名、地址或 Token 提交到仓库。Farming Net 使用独立的 `farming_net_token` Cookie，并把它限制在自己的 Base Path 下，不会覆盖同一主机上 Farming 实例使用的 Cookie。

对于开启联邦通行的环境，门户 Token 相当于所有信任该签名公钥目标的主凭证。它必须保持私密；一旦泄露就应轮换，并且门户本身只应通过可信网络、VPN、SSH Tunnel 或 HTTPS Reverse Proxy 暴露。从目标 Trust 文件移除门户 Issuer，就能撤销门户后续访问，同时不需要修改目标自己的 Token。浏览器网络策略有时会拦截可达性探测，此时门户显示“未确认”，不代表链接一定离线。
