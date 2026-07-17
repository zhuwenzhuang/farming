import '../frontend/reading-anchor.js'
import { Component, type CSSProperties, type ErrorInfo, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { appPath } from './lib/base-path'

type ApplicationErrorBoundaryProps = { children: ReactNode }
type ApplicationErrorBoundaryState = { failed: boolean; error: unknown }
const ERROR_PREVIEW_PARAM = 'farming-error-preview'
const ERROR_PREVIEW_LANGUAGE_PARAM = 'farming-error-language'
const ERROR_PREVIEW_PATH = '/error-preview'

function errorPreviewRouteEnabled() {
  return window.location.pathname.replace(/\/+$/, '') === appPath(ERROR_PREVIEW_PATH).replace(/\/+$/, '')
}

function errorPreviewAppearance() {
  const value = new URLSearchParams(window.location.search).get(ERROR_PREVIEW_PARAM)
  return value === 'light' || value === 'dark' ? value : null
}

async function loadErrorPreviewAppearance() {
  if (!errorPreviewRouteEnabled() || errorPreviewAppearance()) return
  try {
    const response = await fetch(appPath('/api/settings'))
    if (!response.ok) return
    const data = await response.json() as { settings?: { appearance?: unknown } }
    const appearance = data.settings?.appearance
    if (appearance === 'light' || appearance === 'dark') {
      document.body.dataset.appearance = appearance
    }
  } catch {
    // The fallback can still follow the system appearance when settings are unavailable.
  }
}

function errorPreviewEnabled() {
  if (errorPreviewRouteEnabled()) return true
  const value = new URLSearchParams(window.location.search).get(ERROR_PREVIEW_PARAM)
  return value === '1' || value === 'light' || value === 'dark'
}

function failureCopy() {
  const previewLanguage = new URLSearchParams(window.location.search).get(ERROR_PREVIEW_LANGUAGE_PARAM)
  const chinese = previewLanguage === 'zh'
    || (previewLanguage !== 'en' && navigator.language.toLowerCase().startsWith('zh'))
  return chinese
    ? {
      title: 'Farming 暂时无法显示',
      message: '页面加载遇到问题。重新加载不会停止正在运行的 Agent。',
      action: '重新加载',
      errorType: '错误类型',
      failedRequest: '失败请求',
      status: '状态',
      reason: '原因',
      resourceFailure: '资源加载失败',
      renderFailure: '页面渲染失败',
    }
    : {
      title: 'Farming cannot be displayed',
      message: 'The page ran into a loading problem. Reloading will not stop running agents.',
      action: 'Reload',
      errorType: 'Error type',
      failedRequest: 'Failed request',
      status: 'Status',
      reason: 'Reason',
      resourceFailure: 'Resource load failed',
      renderFailure: 'Page render failed',
    }
}

function boundedErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || 'Unknown error')
  return message.replace(/[\r\n]+/g, ' ').trim().slice(0, 500)
}

function safeRequestPath(message: string) {
  const match = message.match(/https?:\/\/[^\s"'<>]+/i)
  if (!match) return null
  try {
    const url = new URL(match[0])
    return `${url.pathname}${url.hash}`
  } catch {
    return null
  }
}

function failureDetails(error: unknown, copy: ReturnType<typeof failureCopy>) {
  const message = boundedErrorMessage(error)
  const requestPath = safeRequestPath(message)
  const resourceFailure = /dynamically imported module|loading chunk|module script/i.test(message)
  const statusValue = error && typeof error === 'object' && 'status' in error
    ? String((error as { status?: unknown }).status ?? '')
    : ''
  return {
    type: resourceFailure ? copy.resourceFailure : copy.renderFailure,
    request: requestPath ? `GET ${requestPath}` : null,
    status: statusValue.slice(0, 40) || null,
    reason: requestPath ? message.replace(/https?:\/\/[^\s"'<>]+/i, requestPath) : message,
  }
}

function previewFailureError() {
  return new Error(`Failed to fetch dynamically imported module: ${window.location.origin}${appPath('/assets/FileEditorPane-preview.js')}`)
}

function failurePalette() {
  const previewAppearance = errorPreviewAppearance()
  const dark = previewAppearance === 'dark'
    || (previewAppearance !== 'light' && (
      document.body.dataset.appearance === 'dark'
      || (!document.body.dataset.appearance && window.matchMedia('(prefers-color-scheme: dark)').matches)
    ))
  return dark
    ? { background: '#0d1117', foreground: '#e6edf3', muted: '#8b949e', border: '#30363d', button: '#21262d' }
    : { background: '#f7f7f6', foreground: '#24292f', muted: '#6e7781', border: '#d8d8d5', button: '#ffffff' }
}

function prepareFailureDocument() {
  document.body.classList.add('code-mode')
  document.body.style.border = '0'
  document.body.style.textShadow = 'none'
}

function reloadFromFailure() {
  if (errorPreviewRouteEnabled()) {
    window.location.replace(appPath('/code/'))
    return
  }
  if (!errorPreviewEnabled()) {
    window.location.reload()
    return
  }
  const url = new URL(window.location.href)
  url.searchParams.delete(ERROR_PREVIEW_PARAM)
  url.searchParams.delete(ERROR_PREVIEW_LANGUAGE_PARAM)
  window.location.replace(url)
}

function ApplicationFailure({ error }: { error: unknown }) {
  const copy = failureCopy()
  const palette = failurePalette()
  const details = failureDetails(error, copy)
  const pageStyle: CSSProperties = {
    position: 'fixed',
    inset: 0,
    zIndex: 2147483647,
    display: 'grid',
    placeItems: 'center',
    padding: 32,
    overflow: 'hidden',
    background: '#050805',
    color: palette.foreground,
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif',
    textShadow: 'none',
  }
  const contentStyle: CSSProperties = {
    position: 'relative',
    zIndex: 2,
    width: 'min(420px, 100%)',
    display: 'grid',
    gap: 12,
    padding: 18,
    border: `1px solid ${palette.border}`,
    borderRadius: 8,
    background: palette.background,
    boxShadow: '0 18px 60px rgba(0, 0, 0, 0.42)',
  }
  const buttonStyle: CSSProperties = {
    width: 'fit-content',
    minHeight: 32,
    padding: '6px 12px',
    border: `1px solid ${palette.border}`,
    borderRadius: 6,
    background: palette.button,
    color: palette.foreground,
    cursor: 'pointer',
    font: 'inherit',
  }
  const detailRowStyle: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: '88px minmax(0, 1fr)',
    gap: 10,
    alignItems: 'start',
    fontSize: 12,
    lineHeight: 1.5,
  }
  const detailValueStyle: CSSProperties = {
    color: palette.foreground,
    fontFamily: 'ui-monospace, "SFMono-Regular", Consolas, monospace',
    overflowWrap: 'anywhere',
  }

  return (
    <main style={pageStyle} data-testid="app-error-fallback" role="alert">
      <iframe
        src={appPath('/crt/')}
        title="Farming CRT recovery"
        data-testid="app-error-crt-background"
        aria-hidden="true"
        tabIndex={-1}
        style={{ position: 'absolute', inset: 0, zIndex: 0, width: '100%', height: '100%', border: 0, pointerEvents: 'none' }}
      />
      <div style={{ position: 'absolute', inset: 0, zIndex: 1, background: 'rgba(0, 0, 0, 0.3)' }} />
      <div style={contentStyle}>
        <span style={{ color: palette.muted, fontSize: 12, letterSpacing: '0.02em' }}>Farming</span>
        <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600, lineHeight: 1.35 }}>{copy.title}</h1>
        <p style={{ margin: 0, color: palette.muted, fontSize: 13, lineHeight: 1.6 }}>{copy.message}</p>
        <div style={{ display: 'grid', gap: 6, padding: '10px 0', borderTop: `1px solid ${palette.border}`, borderBottom: `1px solid ${palette.border}` }}>
          <div style={detailRowStyle}><span style={{ color: palette.muted }}>{copy.errorType}</span><span style={detailValueStyle}>{details.type}</span></div>
          {details.request && <div style={detailRowStyle}><span style={{ color: palette.muted }}>{copy.failedRequest}</span><span style={detailValueStyle}>{details.request}</span></div>}
          {details.status && <div style={detailRowStyle}><span style={{ color: palette.muted }}>{copy.status}</span><span style={detailValueStyle}>{details.status}</span></div>}
          <div style={detailRowStyle}><span style={{ color: palette.muted }}>{copy.reason}</span><span style={detailValueStyle}>{details.reason}</span></div>
        </div>
        <button type="button" style={buttonStyle} onClick={reloadFromFailure}>{copy.action}</button>
      </div>
    </main>
  )
}

class ApplicationErrorBoundary extends Component<ApplicationErrorBoundaryProps, ApplicationErrorBoundaryState> {
  state: ApplicationErrorBoundaryState = { failed: false, error: null }

  static getDerivedStateFromError(error: unknown): ApplicationErrorBoundaryState {
    return { failed: true, error }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    prepareFailureDocument()
    console.error('Farming application render failed', error, info)
  }

  render() {
    if (this.state.failed) return <ApplicationFailure error={this.state.error} />
    return this.props.children
  }
}

function isExpectedMonacoCancellation(value: unknown) {
  if (!(value instanceof Error)) return false
  const message = `${value.name}: ${value.message}`.toLowerCase()
  const stack = String(value.stack || '').toLowerCase()
  return message === 'error: canceled' || message === 'canceled: canceled'
    ? stack.includes('editor.api') || stack.includes('monaco')
    : false
}

window.addEventListener('error', event => {
  if (isExpectedMonacoCancellation(event.error)) {
    event.preventDefault()
  }
})

window.addEventListener('unhandledrejection', event => {
  if (isExpectedMonacoCancellation(event.reason)) {
    event.preventDefault()
  }
})

const normalizedPathname = window.location.pathname.replace(/\/+$/, '')
const isReviewRoute = ['/review']
  .map(path => appPath(path).replace(/\/+$/, ''))
  .includes(normalizedPathname)
const root = createRoot(document.getElementById('root')!)

async function renderApplication() {
  if (errorPreviewEnabled()) {
    await loadErrorPreviewAppearance()
    prepareFailureDocument()
    root.render(<ApplicationFailure error={previewFailureError()} />)
    return
  }
  if (isReviewRoute) {
    const [{ ReviewPage }] = await Promise.all([
      import('./components/review/ReviewPage'),
      import('./styles/review.css'),
    ])
    root.render(<ApplicationErrorBoundary><ReviewPage /></ApplicationErrorBoundary>)
    return
  }

  await import('./styles/tokens.css')
  await import('./styles/main.css')
  await import('./styles/code-mobile.css')
  await import('./styles/code-dark.css')
  const { App } = await import('./App')
  root.render(<ApplicationErrorBoundary><App /></ApplicationErrorBoundary>)
}

void renderApplication().catch(error => {
  prepareFailureDocument()
  console.error('Farming application startup failed', error)
  root.render(<ApplicationFailure error={error} />)
})
