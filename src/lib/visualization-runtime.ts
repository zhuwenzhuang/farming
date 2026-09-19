// Farming's fragment compatibility layer. Complete HTML documents keep their own styles.
export const visualizationStyles = `
:root{font-size:16px;color-scheme:light dark;--font-size-base:14px}
*{box-sizing:border-box}html,body{margin:0;padding:0;background:transparent;color:var(--foreground);font:400 var(--font-size-base)/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
body{display:flow-root}h1,h2,h3{font-weight:500;line-height:1.35;margin:0 0 12px}h1{font-size:24px}h2{font-size:20px}h3{font-size:16px}p{margin:0 0 12px}button,input,select,textarea{font:inherit}button{cursor:pointer}button:disabled{opacity:.5;cursor:default}a{color:var(--blue)}svg{max-width:100%}img,video{max-width:100%;height:auto}[hidden]{display:none!important}
.text-small{font-size:12px}.text-muted{color:var(--muted-foreground)}.text-destructive{color:var(--destructive)}.tabular-nums{font-variant-numeric:tabular-nums}.text-end{text-align:right}.text-center{text-align:center}.text-nowrap{white-space:nowrap}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
.viz-row,.viz-controls{display:flex;align-items:center;flex-wrap:wrap;gap:12px}.viz-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:12px}.card{padding:16px;border:1px solid var(--border);border-radius:8px;background:var(--card);color:var(--card-foreground)}.viz-stat-value{font-size:24px;font-weight:500}.viz-badge{display:inline-block;padding:2px 8px;border-radius:12px;background:var(--secondary);color:var(--secondary-foreground)}
.btn,.nav-link{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:6px 12px;border:1px solid var(--border);border-radius:6px;background:var(--secondary);color:var(--secondary-foreground);text-decoration:none}.btn-primary,.btn[aria-pressed=true],.nav-link.active{background:var(--primary);color:var(--primary-foreground)}.btn-ghost{background:transparent;border-color:transparent}.btn-block{width:100%}.btn:hover,.nav-link:hover{filter:brightness(.96)}:focus-visible{outline:2px solid var(--ring);outline-offset:2px}.nav{display:flex;flex-wrap:wrap;gap:6px}.nav-justified>*{flex:1}.form-label{display:grid;gap:4px}.form-control,.form-select{min-width:0;max-width:100%;padding:6px 8px;border:1px solid var(--input);border-radius:6px;background:var(--background);color:var(--foreground)}.form-check{display:inline-flex;align-items:center;gap:6px}.form-range{accent-color:var(--primary)}.table{border-collapse:collapse;width:100%}.table th,.table td{padding:8px;text-align:left;border-bottom:1px solid var(--border)}.table-sm th,.table-sm td{padding:4px 8px}.table-responsive{overflow-x:auto}.progress{background:var(--muted);height:8px;overflow:hidden}.progress-bar{height:100%;background:var(--viz-series-1)}hr{border:0;border-top:1px solid var(--border);margin:16px 0}.tooltip{position:absolute;z-index:20;padding:6px 10px;background:var(--popover);color:var(--popover-foreground);border:1px solid var(--border);border-radius:6px;pointer-events:none;max-width:300px}
@media(pointer:coarse){.btn,.nav-link{min-height:44px}.form-control,.form-select{font-size:16px}}
`

export function visualizationTheme(element: HTMLElement) {
  const style = getComputedStyle(element)
  const get = (name: string) => style.getPropertyValue(`--code-${name}`).trim()
  const foreground = get('text') || '#24292f'
  const surface = get('bg-canvas') || '#ffffff'
  const tokens: Record<string, string> = {
    background: surface, foreground, card: get('bg-raised') || surface, 'card-foreground': foreground,
    popover: get('bg-raised') || surface, 'popover-foreground': foreground,
    primary: get('emphasis') || foreground, 'primary-foreground': surface,
    secondary: get('bg-inset') || surface, 'secondary-foreground': foreground,
    muted: get('bg-muted') || surface, 'muted-foreground': get('text-subtle') || foreground,
    accent: get('bg-hover') || surface, 'accent-foreground': foreground,
    destructive: get('danger') || '#cf222e', border: get('viz-border') || '#d0d7de', input: get('border') || '#d0d7de', ring: get('accent') || '#0969da',
    blue: get('accent') || '#0969da', orange: get('warning') || '#9a6700', green: get('success') || '#1a7f37',
    red: get('danger') || '#cf222e', purple: get('collaboration-tone-3') || '#8067a5', yellow: get('warning') || '#9a6700',
  }
  for (let i = 1; i <= 6; i++) tokens[`viz-series-${i}`] = get(`viz-series-${i}`) || foreground
  return { tokens, colorScheme: style.colorScheme }
}

// Runs inside the opaque-origin iframe. Only presentation/state messages cross the bridge.
export function visualizationBridge(channel: string, fragment: boolean) {
  const send = (type: string, payload: Record<string, unknown> = {}) => parent.postMessage({ channel, type, ...payload }, '*')
  const host = window as Window & {
    lucide?: { createIcons: (options?: { attrs: Record<string, number> }) => void }
    openai?: { widgetState: unknown; setWidgetState: (state: unknown) => Promise<void>; sendFollowUpMessage: () => Promise<never> }
  }
  if (fragment) host.openai = {
    widgetState: null,
    setWidgetState: async state => {
      const serialized = JSON.stringify(state)
      if (new TextEncoder().encode(serialized).length > 16 * 1024) throw new Error('Visualization state exceeds 16 KiB')
      if (host.openai) host.openai.widgetState = state
      send('state', { state })
    },
    sendFollowUpMessage: async () => { throw new Error('Send the follow-up through the Farming composer') },
  }
  let lastHeight = 0
  let scheduled = false
  const measure = () => {
    if (scheduled) return
    scheduled = true
    // Size is needed even for offscreen transcript entries. Browsers may pause
    // iframe animation frames there, leaving the parent stuck at an old height.
    setTimeout(() => {
      scheduled = false
      const body = document.body
      if (!body) return
      // Use content bounds, not document.scrollHeight (which cannot shrink below the viewport).
      const height = Math.ceil(Math.max(body.getBoundingClientRect().height, ...Array.from(body.children).filter(child => !['absolute', 'fixed'].includes(getComputedStyle(child).position)).map(child => child.getBoundingClientRect().bottom + scrollY)))
      if (height !== lastHeight) { lastHeight = height; send('size', { height }) }
    })
  }
  addEventListener('message', event => {
    if (event.source !== parent || event.data?.channel !== channel) return
    if (event.data.type === 'state' && host.openai) {
      host.openai.widgetState = event.data.state
      dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals: { widgetState: event.data.state } } }))
    }
    if (event.data.type === 'theme') {
      const tokens = event.data.tokens as Record<string, string>
      for (const [name, value] of Object.entries(tokens || {})) {
        if (/^[a-z0-9-]+$/.test(name) && typeof value === 'string') document.documentElement.style.setProperty(`--${name}`, value)
      }
      if (fragment) document.documentElement.style.colorScheme = event.data.colorScheme || 'light'
      dispatchEvent(new Event('resize'))
      dispatchEvent(new Event('farming:themechange'))
    }
  })
  addEventListener('error', event => {
    // ResizeObserver defers undelivered notifications to the next paint. This
    // browser scheduling diagnostic is not a failed script or resource; keep
    // it in the browser console without turning a settled chart into an error.
    if (event instanceof ErrorEvent && !event.error
      && (event.message === 'ResizeObserver loop completed with undelivered notifications.'
        || event.message === 'ResizeObserver loop limit exceeded')) return
    const target = event.target
    const url = target instanceof HTMLScriptElement ? target.src : target instanceof HTMLLinkElement ? target.href : target instanceof HTMLImageElement ? target.src : ''
    send('error', { message: url ? `Resource failed: ${url}` : event instanceof ErrorEvent ? event.message : 'Visualization resource failed' })
  }, true)
  addEventListener('unhandledrejection', event => send('error', { message: String(event.reason?.message || event.reason) }))
  window.addEventListener('securitypolicyviolation', event => send('error', { message: `Blocked resource (${event.violatedDirective}): ${event.blockedURI}` }))
  window.addEventListener('keydown', event => { if (event.key === 'Escape') send('escape') })
  const originalFetch = window.fetch.bind(window)
  window.fetch = async (...args) => {
    const response = await originalFetch(...args)
    if (!response.ok) send('error', { message: `Resource ${response.status}: ${response.url}` })
    return response
  }
  const start = () => {
    new ResizeObserver(measure).observe(document.body)
    new MutationObserver(measure).observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true })
    document.fonts.ready.then(measure)
    addEventListener('load', measure, true)
    measure()
    send('ready')
    if (fragment) host.lucide?.createIcons({ attrs: { width: 16, height: 16 } })
    if (fragment) {
      const tooltip = document.createElement('div')
      tooltip.className = 'tooltip'; tooltip.setAttribute('role', 'tooltip'); tooltip.hidden = true
      document.body.append(tooltip)
      const show = (event: Event) => {
        const target = event.target instanceof Element ? event.target.closest('[data-tooltip]') : null
        if (!target) { tooltip.hidden = true; return }
        tooltip.textContent = target.getAttribute('data-tooltip')
        tooltip.hidden = false
        const box = target.getBoundingClientRect()
        tooltip.style.left = `${Math.max(0, Math.min(box.left, innerWidth - tooltip.offsetWidth))}px`
        tooltip.style.top = `${Math.max(0, box.top + scrollY - tooltip.offsetHeight - 6)}px`
      }
      document.addEventListener('pointerover', show)
      document.addEventListener('focusin', show)
      document.addEventListener('pointerout', () => { tooltip.hidden = true })
      document.addEventListener('focusout', () => { tooltip.hidden = true })
    }
    if (fragment) document.addEventListener('click', event => {
      const tab = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[role=tab]') : null
      const group = tab?.closest('[role=tablist]')
      if (!tab || !group || tab.disabled || tab.getAttribute('aria-disabled') === 'true') return
      group.querySelectorAll('[role=tab]').forEach(item => {
        const active = item === tab
        item.classList.toggle('active', active)
        item.setAttribute('aria-selected', String(active))
        const panel = document.getElementById(item.getAttribute('aria-controls') || '')
        if (panel) panel.hidden = !active
      })
    })
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
}
