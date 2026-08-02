export const DESKTOP_STARTUP_CANCEL_URL = 'farming-desktop://cancel-startup'
export const DESKTOP_STARTUP_REVEAL_DELAY_MS = 500

export class DesktopStartupVisibility {
  private phase: 'pending' | 'visible' | 'complete' = 'pending'

  reveal() {
    if (this.phase !== 'pending') return false
    this.phase = 'visible'
    return true
  }

  complete() {
    if (this.phase === 'complete') return false
    this.phase = 'complete'
    return true
  }
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function desktopStartupDocument(message: string) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Starting Farming</title>
  <style>
    :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
    main { width: min(560px, calc(100vw - 64px)); }
    h1 { margin: 0 0 12px; font-size: 28px; letter-spacing: -0.02em; }
    p { margin: 0; color: color-mix(in srgb, CanvasText 68%, transparent); line-height: 1.5; }
    .progress { margin: 24px 0; min-height: 48px; padding: 14px 16px; border: 1px solid color-mix(in srgb, CanvasText 14%, transparent); border-radius: 12px; background: color-mix(in srgb, CanvasText 4%, Canvas); white-space: pre-wrap; word-break: break-word; }
    a { display: inline-block; padding: 9px 16px; border: 1px solid color-mix(in srgb, CanvasText 24%, transparent); border-radius: 9px; color: CanvasText; text-decoration: none; }
    a:focus-visible { outline: 2px solid Highlight; outline-offset: 2px; }
  </style>
</head>
<body>
  <main>
    <h1>Starting Farming</h1>
    <p>Runtime dependencies were prepared by npm install. Startup only verifies the local environment.</p>
    <div id="startup-progress" class="progress" role="status" aria-live="polite">${escapeHtml(message)}</div>
    <a href="${DESKTOP_STARTUP_CANCEL_URL}">Cancel startup</a>
  </main>
  <script>
    globalThis.farmingDesktopStartupProgress = message => {
      document.getElementById('startup-progress').textContent = String(message)
    }
  </script>
</body>
</html>`
}

export function desktopStartupDataUrl(message: string) {
  return `data:text/html;charset=UTF-8,${encodeURIComponent(desktopStartupDocument(message))}`
}
