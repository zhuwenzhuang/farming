import { useEffect, useRef, useState } from 'react'
import { appPath } from '../../../src/lib/base-path'
import { writeClipboardText } from '../../../src/lib/clipboard'
import { CodeSelect } from '../../../src/components/CodeSelect'
import { PuzzleGlyph } from '../../../src/components/IconGlyphs'

type Target = { agentId: string; name: string }
type State = { enabled: boolean; revision: number; targets: Target[]; endpointBaseUrl: string }
type Grant = { id: string; principal: { name?: string }; targets: string[]; expiresAt: number }
type Issued = { token: string; endpoint: string }

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(appPath(path), { ...options, headers: { 'Content-Type': 'application/json' },
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error || 'HTTP ' + response.status)
  return body as T
}

export function A2aPluginCard({ language }: { language: string }) {
  const zh = language === 'zh'
  const copy = zh ? {
    title: '外部 Agent 接入 · A2A', description: '允许外部 Agent 向指定的 Farming Agent 发送请求并获取结果。',
    enabled: '已启用', disabled: '未启用', loading: '正在读取…', unavailable: '读取失败', configure: '配置', close: '收起', refresh: '刷新',
    enable: '启用外部接入', target: '允许访问的 Agent', name: '外部应用名称', add: '创建接入凭据',
    noTargets: '先启动一个 Chat Agent，再刷新可用列表。', noGrants: '还没有外部授权。', revoke: '撤销', expires: '到期',
    token: '凭据', endpoint: 'A2A 地址', once: '凭据仅显示一次。将地址和凭据配置给外部应用。',
    copy: '复制接入配置', copied: '已复制', copyFailed: '复制失败，请手动复制。', pending: '操作结果尚未确认，请刷新核对后再操作。',
    disabledHint: '关闭时拒绝外部访问，保留已有授权；重新启用后，未过期且未撤销的授权恢复可用。已接收的工作继续执行。',
    namePlaceholder: '例如：CI 审查服务', hideToken: '已保存凭据',
  } : {
    title: 'External Agent access · A2A', description: 'Let external Agents send requests to selected Farming Agents and retrieve results.',
    enabled: 'Enabled', disabled: 'Disabled', loading: 'Loading…', unavailable: 'Unavailable', configure: 'Configure', close: 'Collapse', refresh: 'Refresh',
    enable: 'Enable external access', target: 'Allow access to Agent', name: 'External application name', add: 'Create access credential',
    noTargets: 'Start a Chat Agent, then refresh the available targets.', noGrants: 'No external grants yet.', revoke: 'Revoke', expires: 'Expires',
    token: 'Credential', endpoint: 'A2A endpoint', once: 'This credential is shown only once. Configure the endpoint and credential in the external application.',
    copy: 'Copy connection settings', copied: 'Copied', copyFailed: 'Copy failed. Copy the fields manually.', pending: 'The outcome is unconfirmed. Refresh to reconcile before another action.',
    disabledHint: 'Disabling blocks external access and retains grants. Reenabling restores unexpired, unrevoked grants. Already accepted work continues.',
    namePlaceholder: 'For example: CI reviewer', hideToken: 'Credential saved',
  }
  const [state, setState] = useState<State | null>(null)
  const [grants, setGrants] = useState<Grant[]>([])
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [target, setTarget] = useState('')
  const [name, setName] = useState('')
  const [issued, setIssued] = useState<Issued | null>(null)
  const [copied, setCopied] = useState(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    void Promise.all([
      request<State>('/api/extensions/a2a', { signal: controller.signal }),
      request<{ grants: Grant[] }>('/api/communication/grants', { signal: controller.signal }),
    ]).then(([value, list]) => {
      if (controller.signal.aborted) return
      setState(value); setGrants(list.grants); setNeedsRefresh(false)
      setTarget(current => value.targets.some(item => item.agentId === current) ? current : value.targets[0]?.agentId || '')
    }).catch(caught => {
      if (!controller.signal.aborted) { setState(null); setError(caught instanceof Error ? caught.message : String(caught)) }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [refresh, expanded])

  const mutate = async (operation: () => Promise<void>) => {
    if (busy || loading || needsRefresh) return
    setBusy(true); setError('')
    try { await operation(); if (alive.current) setRefresh(current => current + 1) }
    catch (caught) {
      if (alive.current) { setNeedsRefresh(true); setError((caught instanceof Error ? caught.message : String(caught)) + ' ' + copy.pending) }
    } finally { if (alive.current) setBusy(false) }
  }
  const toggle = () => {
    if (!state) return
    void mutate(async () => {
      await request('/api/extensions/a2a', { method: 'PUT', body: JSON.stringify({ enabled: !state.enabled, expectedRevision: state.revision }) })
    })
  }
  const issue = () => {
    if (!state?.enabled || !target || !name.trim()) return
    void mutate(async () => {
      const result = await request<{ token: string }>('/api/communication/grants', { method: 'POST', body: JSON.stringify({
        peerId: Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''), name: name.trim(), targets: [target], expiresAt: Date.now() + 86400000,
      }) })
      if (alive.current) {
        setIssued({ token: result.token, endpoint: new URL(state.endpointBaseUrl + '/agents/' + encodeURIComponent(target), location.origin).href })
        setCopied(false); setName('')
      }
    })
  }
  const blocked = busy || loading || needsRefresh || !state
  return <article className="code-plugin-card" data-testid="code-plugin-a2a">
    <span className="code-plugin-card-icon" aria-hidden="true"><PuzzleGlyph /></span>
    <div className="code-plugin-card-copy">
      <div className="code-plugin-card-title"><h3>{copy.title}</h3><span className={'code-plugin-status ' + (state?.enabled && !loading ? 'enabled' : '')}>
        {loading ? copy.loading : !state ? copy.unavailable : state.enabled ? copy.enabled : copy.disabled}
      </span></div>
      <p>{copy.description}</p>
      {error && <div className="code-plugin-error" role="alert">{error}</div>}
      {(error || expanded) && <div className="code-plugin-shared-config-actions">
        <button type="button" disabled={busy || loading} onClick={() => setRefresh(value => value + 1)}>{copy.refresh}</button>
      </div>}
      {expanded && <div className="code-plugin-shared-config-form" data-testid="code-plugin-a2a-config">
        <label className="code-plugin-shared-config-master">
          <input type="checkbox" checked={Boolean(state?.enabled)} disabled={Boolean(blocked)} onChange={toggle} data-testid="code-plugin-a2a-enabled" />
          <span>{copy.enable}</span>
        </label>
        <small>{copy.disabledHint}</small>
        {state?.enabled && !issued && <form className="code-plugin-shared-config-form" onSubmit={event => { event.preventDefault(); issue() }}>
          <label><span>{copy.name}</span><input className="code-field" aria-label={copy.name} maxLength={240} required value={name} placeholder={copy.namePlaceholder} disabled={Boolean(blocked)} onChange={event => setName(event.target.value)} /></label>
          {state.targets.length ? <CodeSelect className="code-plugin-select" label={copy.target} value={target} disabled={Boolean(blocked)}
            options={state.targets.map(item => ({ value: item.agentId, label: item.name }))} onChange={setTarget} testId="code-plugin-a2a-target" />
            : <p>{copy.noTargets}</p>}
          <div className="code-plugin-shared-config-actions"><button className="primary" type="submit" disabled={Boolean(blocked) || !target || !name.trim()}>{copy.add}</button></div>
        </form>}
        {issued && <div className="code-plugin-shared-config-form">
          <p>{copy.once}</p>
          <label><span>{copy.endpoint}</span><input className="code-field" aria-label={copy.endpoint} readOnly value={issued.endpoint} /></label>
          <label><span>{copy.token}</span><input className="code-field" aria-label={copy.token} readOnly value={issued.token} /></label>
          <div className="code-plugin-shared-config-actions">
            <button type="button" onClick={async () => {
              try {
                const copied = await writeClipboardText(JSON.stringify({ url: issued.endpoint, headers: { Authorization: 'Bearer ' + issued.token, 'A2A-Version': '1.0' } }, null, 2))
                if (alive.current) { setCopied(copied); if (!copied) setError(copy.copyFailed) }
              }
              catch { if (alive.current) setError(copy.copyFailed) }
            }}>{copied ? copy.copied : copy.copy}</button>
            <button type="button" onClick={() => setIssued(null)}>{copy.hideToken}</button>
          </div>
        </div>}
        {!loading && !grants.length && <small>{copy.noGrants}</small>}
        {grants.map(grant => <div key={grant.id} className="code-plugin-a2a-grant">
          <div><strong>{grant.principal.name}</strong><small>{grant.targets.map(id => state?.targets.find(item => item.agentId === id)?.name || id).join(', ')} · {copy.expires}: {new Date(grant.expiresAt).toLocaleString()}</small></div>
          <button type="button" className="code-plugin-toggle" disabled={Boolean(blocked)} onClick={() => void mutate(async () => {
            await request('/api/communication/grants/' + encodeURIComponent(grant.id), { method: 'DELETE' })
            if (alive.current) setIssued(null)
          })}>{copy.revoke}</button>
        </div>)}
      </div>}
    </div>
    <button type="button" className="code-plugin-toggle" disabled={busy} onClick={() => setExpanded(value => !value)}>{expanded ? copy.close : copy.configure}</button>
  </article>
}
