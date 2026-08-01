import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type {
  DesktopBackendInput,
  DesktopBackendProfile,
  DesktopBackendStatus,
  DesktopState,
} from '../../shared/desktop-contract'
import { ArrowLeftGlyph, PlusGlyph, RemoteGlyph } from './IconGlyphs'
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

export function DesktopConnectionsPanel({ language, onBack }: { language: UiLanguage; onBack: () => void }) {
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
      if (!disposed) setError(reason instanceof Error ? reason.message : String(reason))
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

  if (!bridge) return null

  const run = async (operation: () => Promise<DesktopState>) => {
    setBusy(true)
    setError('')
    try {
      setState(await operation())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const activate = (backendId: string) => run(() => bridge.activateBackend(backendId))

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
      const savedState = await bridge.saveBackend(input)
      setState(savedState)
      const backendId = draft.id
        ?? savedState.profiles.find(profile => !previousIds.has(profile.id))?.id
      if (!backendId) throw new Error('Saved backend could not be identified.')
      setDraft(null)
      setState(await bridge.activateBackend(backendId))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
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
          disabled={busy || active}
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
            <small>Farming {connection.server.version} · {connection.server.platform}/{connection.server.arch}</small>
          )}
          {connection?.error && <small className="desktop-connection-error">{connection.error}</small>}
        </div>
        {!local && (
          <div className="desktop-connection-actions">
            <button type="button" disabled={busy} onClick={() => setDraft(draftForProfile(profile))}>{zh ? '编辑' : 'Edit'}</button>
            <button
              type="button"
              className="is-danger"
              disabled={busy}
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
    <div className="desktop-connections-panel" data-testid="desktop-connections-panel">
      <header className="desktop-connections-header">
        <button type="button" onClick={onBack} aria-label={zh ? '返回插件' : 'Back to Plugins'} title={zh ? '返回插件' : 'Back to Plugins'}>
          <ArrowLeftGlyph />
        </button>
        <div>
          <h2>{zh ? '连接' : 'Connections'}</h2>
          <p>{zh ? '本机环境随桌面应用启动；需要时再连接远程 SSH 主机。' : 'Your local environment starts with the desktop app. Connect an SSH host only when needed.'}</p>
        </div>
      </header>

      <section className="desktop-connections-section">
        <header>
          <div>
            <h3>{zh ? '本机环境' : 'Local environment'}</h3>
            <p>{zh ? '默认可用，无需配置。' : 'Ready by default with no setup.'}</p>
          </div>
        </header>
        <div className="desktop-connections-list">{localProfile ? renderProfile(localProfile) : null}</div>
      </section>

      <section className="desktop-connections-section">
        <header>
          <div>
            <h3>{zh ? '远程 SSH' : 'Remote SSH'}</h3>
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
          <h3>{draft.id ? (zh ? '编辑远程' : 'Edit remote') : (zh ? '添加远程' : 'Add remote')}</h3>
          <label>
            <span>{zh ? '名称' : 'Name'}</span>
            <input required maxLength={80} value={draft.name} onChange={event => setDraft(current => current ? ({ ...current, name: event.target.value }) : current)} placeholder={zh ? '开发机' : 'Development host'} />
          </label>
          <label>
            <span>{zh ? 'SSH 主机' : 'SSH host'}</span>
            <input required value={draft.sshHost} onChange={event => setDraft(current => current ? ({ ...current, sshHost: event.target.value }) : current)} placeholder="my-dev-host" />
            <small>{zh ? '使用 ~/.ssh/config 中的 Host；用户名、端口、密钥和跳板机均自动读取。' : 'Uses a Host from ~/.ssh/config, including user, port, key, and jump host.'}</small>
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
  )
}
