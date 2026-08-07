# Connect An External CDP Browser

> Chinese version: [external-cdp-browser.zh_cn.md](./external-cdp-browser.zh_cn.md)

Farming can operate and display a Chromium browser that another process, user, or Agent manages. Farming connects through Chrome DevTools Protocol (CDP); it does not access the Docker socket, choose an image, or create, restart, and delete containers.

## Contract

Start Chromium with a browser-level CDP endpoint that is reachable only on the Farming host's loopback interface. The image must run Chromium as a non-root user with its sandbox enabled. Publish only the CDP port to host loopback and keep the container on an isolated bridge network. For example, with an image that documents sandboxed non-root operation:

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

Do not add `--no-sandbox`, run the container as root, use host networking, or publish the port on `0.0.0.0`. Some Chromium builds ignore `--remote-debugging-address=0.0.0.0` and bind only inside the container; use the image's documented sandbox-preserving CDP proxy instead of weakening process or network isolation. CDP grants full control of that browser. For a browser on another machine, create an SSH tunnel so Farming still connects to a local loopback address.

Verify the endpoint:

```bash
curl --fail http://127.0.0.1:9222/json/version
```

In **Plugins → Browser**, choose **External CDP**, enter the endpoint, apply the selection, and enable the Browser plugin. No Farming restart is required. Browser Resources then use the existing Farming Browser Viewer and `farming browser` Agent commands. Each Resource creates and owns its page targets, but the external owner remains responsible for the browser process, container, image, profile, and endpoint availability.

The field accepts loopback `http`, `https`, `ws`, or `wss` endpoints. Farming intentionally rejects non-loopback addresses, embedded credentials, and query parameters. Changing the selected browser source stops running Browser Resources before the new selection is committed.
