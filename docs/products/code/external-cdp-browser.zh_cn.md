# 连接外部 CDP 浏览器

> English version: [external-cdp-browser.md](./external-cdp-browser.md)

Farming 可以操作和展示由其他进程、用户或 Agent 管理的 Chromium 浏览器。Farming 只通过 Chrome DevTools Protocol（CDP）连接，不访问 Docker Socket，不选择镜像，也不创建、重启或删除容器。

## 接入约定

启动 Chromium 的 Browser 级 CDP Endpoint，并确保它只能从 Farming Host 的回环地址访问。Docker 的发布方式由镜像决定。例如在 Linux 上，Host Network 也能让只监听容器回环地址的 Chromium 出现在 Host 回环地址上：

```bash
docker run --rm --name farming-cdp --init --shm-size=1g \
  --network host \
  <chromium-image> <chromium-command> \
  --headless=new --no-sandbox \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/farming-cdp-profile \
  about:blank
```

部分 Chromium Build 会忽略 `--remote-debugging-address=0.0.0.0`，只监听容器内部回环地址，因此普通 `-p` 映射可能不可用。此时应使用镜像文档提供的 CDP Proxy，或在 Linux 上使用 Host Network；Farming 不需要 Docker 专用模式。CDP 等同于对该浏览器的完整控制权限。不要把这个端口发布到 `0.0.0.0` 或公网。浏览器位于另一台机器时，请建立 SSH Tunnel，让 Farming 仍然只连接本机回环地址。

启动 Farming 前先验证 Endpoint：

```bash
curl --fail http://127.0.0.1:9222/json/version
```

然后停止已有 Farming Server，并带 Endpoint 重新启动：

```bash
farming stop
FARMING_BROWSER_CDP_URL=http://127.0.0.1:9222 farming daemon
```

在**设置 → 扩展**中启用**外部浏览器**。Browser Resource 随后复用 Farming 已有的 Browser Viewer 和 `farming browser` Agent 命令。每个 Resource 会创建并拥有自己的页面 Target；浏览器进程、容器、镜像、Profile 与 Endpoint 可用性仍由外部 Owner 负责。

`FARMING_BROWSER_CDP_URL` 接受回环地址上的 `http`、`https`、`ws` 或 `wss` Endpoint。Farming 会拒绝非回环地址、内嵌凭证和 Query Parameter。显式配置的外部 Endpoint 优先于系统浏览器发现；去掉变量并重启 Farming 后恢复系统浏览器路径。
