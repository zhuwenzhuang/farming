# 连接外部 CDP 浏览器

> English version: [external-cdp-browser.md](./external-cdp-browser.md)

Farming 可以操作和展示由其他进程、用户或 Agent 管理的 Chromium 浏览器。Farming 只通过 Chrome DevTools Protocol（CDP）连接，不访问 Docker Socket，不选择镜像，也不创建、重启或删除容器。

## 接入约定

启动 Chromium 的 Browser 级 CDP Endpoint，并确保它只能从 Farming Host 的回环地址访问。镜像必须以非 Root 用户运行 Chromium，并保留 Chromium Sandbox。只把 CDP 端口发布到 Host 回环地址，同时让容器使用隔离的 Bridge Network。例如，对于明确支持 Sandbox 与非 Root 运行的镜像：

```bash
docker network create farming-cdp
docker run --rm --name farming-cdp --init --shm-size=1g \
  --network farming-cdp \
  --publish 127.0.0.1:9222:9222 \
  --user 1000:1000 \
  <chromium-image> <chromium-command> \
  --headless=new \
  --remote-debugging-address=0.0.0.0 \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/farming-cdp-profile \
  about:blank
```

不要添加 `--no-sandbox`、以 Root 运行容器、使用 Host Network，或把端口发布到 `0.0.0.0`。部分 Chromium Build 会忽略 `--remote-debugging-address=0.0.0.0`，只监听容器内部回环地址；此时应使用镜像文档提供且保留 Sandbox 的 CDP Proxy，而不是削弱进程或网络隔离。CDP 等同于对该浏览器的完整控制权限。浏览器位于另一台机器时，请建立 SSH Tunnel，让 Farming 仍然只连接本机回环地址。

先验证 Endpoint：

```bash
curl --fail http://127.0.0.1:9222/json/version
```

在**插件 → 浏览器**中选择**外部 CDP**，填写 Endpoint，应用选择，然后启用浏览器插件。不需要重启 Farming。Browser Resource 随后复用 Farming 已有的 Browser Viewer 和 `farming browser` Agent 命令。每个 Resource 会创建并拥有自己的页面 Target；浏览器进程、容器、镜像、Profile 与 Endpoint 可用性仍由外部 Owner 负责。

该输入框接受回环地址上的 `http`、`https`、`ws` 或 `wss` Endpoint。Farming 会拒绝非回环地址、内嵌凭证和 Query Parameter。切换浏览器来源时，Farming 会先停止正在运行的 Browser Resource，再提交新的选择。
