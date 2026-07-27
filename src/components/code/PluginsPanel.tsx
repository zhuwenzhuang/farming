import { useEffect, useMemo, useState } from 'react'
import { appPath } from '@/lib/base-path'
import { ArrowLeftGlyph, PuzzleGlyph } from '@/components/IconGlyphs'
import type { UiLanguage } from '@/lib/ui-preferences'
import type { BrowserCapability } from '../../../extensions/browser/frontend/types'

function pluginCopy(language: UiLanguage) {
  const zh = language === 'zh'
  return {
    title: zh ? '插件' : 'Plugins',
    description: zh ? '管理 Farming 和 Agent 可以使用的能力。' : 'Manage capabilities available to Farming and Agents.',
    back: zh ? '返回工作区' : 'Back to workspace',
    browser: zh ? '浏览器' : 'Browser',
    browserDescription: zh
      ? '让 Agent 操作网页，并在 Farming 中查看同一个浏览器。'
      : 'Let Agents operate webpages and view the same browser in Farming.',
    enabled: zh ? '已启用' : 'Enabled',
    disabled: zh ? '已停用' : 'Disabled',
    unavailable: zh ? '未就绪' : 'Not ready',
    checking: zh ? '正在检查…' : 'Checking…',
    systemBrowser: zh ? '系统 Chromium' : 'System Chromium',
    externalBrowser: zh ? '外部 CDP' : 'External CDP',
    unavailableHint: zh
      ? '需要兼容的 Chromium 浏览器，或本机回环地址上的外部 CDP。'
      : 'Requires a compatible Chromium browser or an external CDP endpoint on loopback.',
    enable: zh ? '启用' : 'Enable',
    disable: zh ? '停用' : 'Disable',
    saveFailed: zh ? '浏览器插件设置保存失败' : 'Failed to save Browser plugin settings',
  }
}

function browserSource(capability: BrowserCapability | null, copy: ReturnType<typeof pluginCopy>) {
  if (!capability?.browser) return ''
  return capability.browser.kind === 'external-cdp' ? copy.externalBrowser : copy.systemBrowser
}

export function PluginsPanel({
  capability,
  loading,
  language,
  onBack,
  onRefreshCapability,
}: {
  capability: BrowserCapability | null
  loading: boolean
  language: UiLanguage
  onBack: () => void
  onRefreshCapability: () => void
}) {
  const copy = useMemo(() => pluginCopy(language), [language])
  const [enabled, setEnabled] = useState(capability?.enabled === true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (capability) setEnabled(capability.enabled)
  }, [capability])

  const toggleBrowser = async () => {
    if (saving || (!capability?.browser && !enabled)) return
    const nextEnabled = !enabled
    setSaving(true)
    setError('')
    try {
      const response = await fetch(appPath('/api/settings'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ browserExtensionEnabled: nextEnabled }),
      })
      const data = await response.json().catch(() => ({})) as {
        error?: string
        settings?: { browserExtensionEnabled?: boolean }
      }
      if (!response.ok) throw new Error(data.error || copy.saveFailed)
      setEnabled(data.settings?.browserExtensionEnabled === true)
      onRefreshCapability()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : copy.saveFailed)
    } finally {
      setSaving(false)
    }
  }

  const browserReady = Boolean(capability?.browser)
  const status = loading && capability === null
    ? copy.checking
    : browserReady
      ? enabled ? copy.enabled : copy.disabled
      : copy.unavailable

  return (
    <div className="code-plugins-panel" data-testid="code-plugins-panel">
      <header className="code-plugins-panel-header">
        <button type="button" onClick={onBack} aria-label={copy.back} title={copy.back}>
          <ArrowLeftGlyph />
        </button>
        <div>
          <h2>{copy.title}</h2>
          <p>{copy.description}</p>
        </div>
      </header>

      <section className="code-plugin-card" data-testid="code-plugin-browser">
        <span className="code-plugin-card-icon" aria-hidden="true">
          <PuzzleGlyph />
        </span>
        <div className="code-plugin-card-copy">
          <div className="code-plugin-card-title">
            <h3>{copy.browser}</h3>
            <span className={`code-plugin-status ${browserReady && enabled ? 'enabled' : ''}`}>{status}</span>
          </div>
          <p>{copy.browserDescription}</p>
          {browserReady ? (
            <small>{browserSource(capability, copy)}</small>
          ) : (
            <small>{copy.unavailableHint}</small>
          )}
          {error && <div className="code-plugin-error" role="alert">{error}</div>}
        </div>
        <button
          type="button"
          className={`code-plugin-toggle ${enabled ? 'active' : ''}`}
          aria-pressed={enabled}
          disabled={saving || (!browserReady && !enabled)}
          onClick={() => void toggleBrowser()}
        >
          {enabled ? copy.disable : copy.enable}
        </button>
      </section>
    </div>
  )
}
