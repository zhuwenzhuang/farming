# Connect An External CDP Browser

> Chinese version: [external-cdp-browser.zh_cn.md](./external-cdp-browser.zh_cn.md)

Farming can operate and display a Chromium browser that another process, user, or Agent manages. Farming connects through Chrome DevTools Protocol (CDP); it does not access the Docker socket, choose an image, or create, restart, and delete containers.

## Contract

Start Chromium with a browser-level CDP endpoint that is reachable only on the Farming host's loopback interface. Docker publication is image-specific. For example, on Linux, host networking also makes a Chromium build that binds container loopback available on host loopback:

```bash
docker run --rm --name farming-cdp --init --shm-size=1g \
  --network host \
  <chromium-image> <chromium-command> \
  --headless=new --no-sandbox \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/farming-cdp-profile \
  about:blank
```

Some Chromium builds ignore `--remote-debugging-address=0.0.0.0` and bind only inside the container, so a normal `-p` mapping may not work. In that case use the image's documented CDP proxy or Linux host networking; Farming does not need a Docker-specific mode. CDP grants full control of that browser. Never publish this port on `0.0.0.0` or the public network. For a browser on another machine, create an SSH tunnel so Farming still connects to a local loopback address.

Verify the endpoint:

```bash
curl --fail http://127.0.0.1:9222/json/version
```

In **Plugins → Browser**, choose **External CDP**, enter the endpoint, apply the selection, and enable the Browser plugin. No Farming restart is required. Browser Resources then use the existing Farming Browser Viewer and `farming browser` Agent commands. Each Resource creates and owns its page targets, but the external owner remains responsible for the browser process, container, image, profile, and endpoint availability.

The field accepts loopback `http`, `https`, `ws`, or `wss` endpoints. Farming intentionally rejects non-loopback addresses, embedded credentials, and query parameters. Changing the selected browser source stops running Browser Resources before the new selection is committed.
