import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type {
  DesktopBackendInput,
  DesktopBackendProfile,
  DesktopBackendStatus,
  DesktopState,
} from '../../shared/desktop-contract'
import { PlusGlyph, RemoteGlyph } from './IconGlyphs'
import type { UiLanguage } from '@/lib/ui-preferences'

const bridge = window.farmingDesktop

type Draft = {
  id?: string
  name: string
  sshHost: string
  farmingHome: string
}

function emptyDraft(): Draft {
  return { name: '', sshHost: '', farmingHome: '' }
}

function draftForProfile(profile: DesktopBackendProfile): Draft {
  return {
    id: profile.id,
    name: profile.name,
    sshHost: profile.sshHost,
    farmingHome: profile.farmingHome,
  }
}

function statusLabel(status: DesktopBackendStatus, zh: boolean) {
  const labels: Record<DesktopBackendStatus, [string, string]> = {
    disconnected: ['Disconnected', '未连接'],
    connecting: ['Connecting…', '正在连接…'],
    ready: ['Connected', '已连接'],
    error: ['Connection failed', '连接失败'],
  }
  return labels[status][zh ? 1 : 0]
}

function bridgeErrorMessage(reason: unknown) {
  return (reason instanceof Error ? reason.message : String(reason))
    .replace(/^Error invoking remote method '[^']+': Error:\s*/, '')
}

export function DesktopConnectionsPanel({ language }: { language: UiLanguage }) {
  const zh = language === 'zh'
  const [state, setState] = useState<DesktopState | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!bridge) return undefined
    let disposed = false
    void bridge.getState().then(next => {
      if (!disposed) setState(next)
    }).catch(reason => {
      if (!disposed) setError(bridgeErrorMessage(reason))
    })
    const unsubscribe = bridge.onStateChanged(next => {
      if (!disposed) setState(next)
    })
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  const connectionById = useMemo(() => new Map(
    state?.connections.map(connection => [connection.backendId, connection]) ?? [],
  ), [state?.connections])
  const localProfile = state?.profiles.find(profile => profile.kind === 'local')
  const remoteProfiles = state?.profiles.filter(profile => profile.kind === 'remote') ?? []
  const activeProfile = state?.profiles.find(profile => profile.id === state.activeBackendId)

  if (!bridge) return null

  const run = async (operation: () => Promise<DesktopState>) => {
    setBusy(true)
    setError('')
    try {
      setState(await operation())
    } catch (reason) {
      setError(bridgeErrorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  const activate = async (backendId: string) => {
    setError('')
    try {
      setState(await bridge.activateBackend(backendId))
    } catch (reason) {
      setError(bridgeErrorMessage(reason))
    }
  }

  const cancelConnection = async (backendId: string) => {
    setError('')
    try {
      setState(await bridge.disconnectBackend(backendId))
    } catch (reason) {
      setError(bridgeErrorMessage(reason))
    }
  }

  const saveAndActivate = async (event: FormEvent) => {
    event.preventDefault()
    if (!draft) return
    const previousIds = new Set(state?.profiles.map(profile => profile.id) ?? [])
    const input: DesktopBackendInput = {
      id: draft.id,
      name: draft.name,
      transport: 'ssh',
      sshHost: draft.sshHost,
      farmingHome: draft.farmingHome,
    }
    setBusy(true)
    setError('')
    try {
      const savedState = await bridge.saveAndActivateBackend(input)
      setState(savedState)
      const backendId = draft.id ?? savedState.profiles.find(profile => !previousIds.has(profile.id))?.id
      if (!backendId) throw new Error('Saved backend could not be identified.')
      setDraft(null)
    } catch (reason) {
      setError(bridgeErrorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  const renderProfile = (profile: DesktopBackendProfile) => {
    const connection = connectionById.get(profile.id)
    const status = connection?.status ?? 'disconnected'
    const active = state?.activeBackendId === profile.id
    const local = profile.kind === 'local'
    return (
      <div className="desktop-connection-row" key={profile.id} data-testid={`desktop-connection-${profile.id}`}>
        <button
          type="button"
          className={`desktop-connection-switch ${active ? 'active' : ''}`}
          role="switch"
          aria-checked={active}
          aria-label={zh ? `使用 ${profile.name}` : `Use ${profile.name}`}
          disabled={busy || status === 'connecting' || (active && status === 'ready')}
          onClick={() => void activate(profile.id)}
        >
          <span />
        </button>
        <span className="desktop-connection-icon" aria-hidden="true"><RemoteGlyph /></span>
        <div className="desktop-connection-copy">
          <strong>{local ? (zh ? '这台 Mac' : 'This Mac') : profile.name}</strong>
          <small>
            <i className={`desktop-backend-status is-${status}`} aria-hidden="true" />
            {connection?.message || statusLabel(status, zh)}
          </small>
          {!local && <small>{profile.sshHost}</small>}
          {connection?.server && (
            <>
              <small>
                Farming {connection.server.version} · {connection.server.platform}/{connection.server.arch}
                {' · '}{connection.server.runtime}
              </small>
              <small>Farming Home: {profile.farmingHome}</small>
            </>
          )}
          {connection?.error && <small className="desktop-connection-error">{connection.error}</small>}
        </div>
        {!local && (
          <div className="desktop-connection-actions">
            {status === 'connecting' ? (
              <button type="button" onClick={() => void cancelConnection(profile.id)}>{zh ? '取消连接' : 'Cancel'}</button>
            ) : status === 'error' ? (
              <button type="button" disabled={busy} onClick={() => void activate(profile.id)}>{zh ? '重试' : 'Retry'}</button>
            ) : null}
            <button type="button" disabled={busy || status === 'connecting'} onClick={() => setDraft(draftForProfile(profile))}>{zh ? '编辑' : 'Edit'}</button>
            <button
              type="button"
              className="is-danger"
              disabled={busy || status === 'connecting'}
              onClick={() => {
                if (!window.confirm(zh ? `删除远端“${profile.name}”？` : `Remove remote “${profile.name}”?`)) return
                void run(() => bridge.removeBackend(profile.id))
              }}
            >
              {zh ? '删除' : 'Remove'}
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <article
      id="code-plugin-connections"
      className="code-plugin-card desktop-connections-panel"
      data-testid="desktop-connections-panel"
      tabIndex={-1}
    >
      <span className="code-plugin-card-icon" aria-hidden="true"><RemoteGlyph /></span>
      <div className="code-plugin-card-copy desktop-connections-content">
        <header className="desktop-connections-header">
          <div className="code-plugin-card-title">
            <h3>{zh ? '连接' : 'Connections'}</h3>
            <span className="code-plugin-status enabled">Desktop</span>
            {activeProfile ? (
              <span className="desktop-active-environment">
                {zh ? '当前：' : 'Using: '}{activeProfile.kind === 'local' ? (zh ? '这台 Mac' : 'This Mac') : activeProfile.name}
              </span>
            ) : null}
          </div>
          <p>{zh ? '由这台 Mac 的桌面应用管理，切换远端后仍可随时返回本机或其他主机。' : 'Managed by this Mac desktop app, so you can always return here or switch to another host.'}</p>
        </header>

        <section className="desktop-connections-section">
          <header>
            <div>
              <h4>{zh ? '本机环境' : 'Local environment'}</h4>
              <p>{zh ? '默认可用，无需配置。' : 'Ready by default with no setup.'}</p>
            </div>
          </header>
          <div className="desktop-connections-list">{localProfile ? renderProfile(localProfile) : null}</div>
        </section>

        <section className="desktop-connections-section">
          <header>
            <div>
              <h4>{zh ? '远程 SSH' : 'Remote SSH'}</h4>
              <p>{zh ? '使用系统 OpenSSH 配置；Farming 自动发现、安装和启动远端 Server。' : 'Uses system OpenSSH; Farming discovers, installs, and starts the remote Server.'}</p>
            </div>
            <button type="button" className="desktop-connections-add" disabled={busy} onClick={() => setDraft(emptyDraft())}>
              <PlusGlyph />
              <span>{zh ? '添加' : 'Add'}</span>
            </button>
          </header>
          {remoteProfiles.length > 0
            ? <div className="desktop-connections-list">{remoteProfiles.map(renderProfile)}</div>
            : <p className="desktop-connections-empty">{zh ? '尚未添加远程主机。' : 'No remote hosts added.'}</p>}
        </section>

        {draft && (
          <form className="desktop-connections-form" onSubmit={event => void saveAndActivate(event)}>
            <h4>{draft.id ? (zh ? '编辑远程' : 'Edit remote') : (zh ? '添加远程' : 'Add remote')}</h4>
            <label>
              <span>{zh ? '名称' : 'Name'}</span>
              <input required maxLength={80} value={draft.name} onChange={event => setDraft(current => current ? ({ ...current, name: event.target.value }) : current)} placeholder={zh ? '开发机' : 'Development host'} />
            </label>
            <label>
              <span>{zh ? 'SSH 主机' : 'SSH host'}</span>
              <input required value={draft.sshHost} onChange={event => setDraft(current => current ? ({ ...current, sshHost: event.target.value }) : current)} placeholder="my-dev-host" />
              <small>{zh ? '可填写 ~/.ssh/config 中的 Host，或 user@hostname；自定义端口、密钥和跳板机从 OpenSSH 配置读取。' : 'Use a Host from ~/.ssh/config or user@hostname; custom ports, keys, and jump hosts come from OpenSSH config.'}</small>
            </label>
            <label>
              <span>{zh ? 'Farming Home（可选）' : 'Farming Home (optional)'}</span>
              <input value={draft.farmingHome} onChange={event => setDraft(current => current ? ({ ...current, farmingHome: event.target.value }) : current)} placeholder="~/.farming-desktop" />
            </label>
            {error && <div className="desktop-connections-error" role="alert">{error}</div>}
            <div className="desktop-connections-form-actions">
              <button type="button" disabled={busy} onClick={() => setDraft(null)}>{zh ? '取消' : 'Cancel'}</button>
              <button type="submit" className="primary" disabled={busy}>{busy ? (zh ? '连接中…' : 'Connecting…') : (zh ? '保存并使用' : 'Save and use')}</button>
            </div>
          </form>
        )}
        {!draft && error && <div className="desktop-connections-error" role="alert">{error}</div>}
      </div>
    </article>
  )
}
