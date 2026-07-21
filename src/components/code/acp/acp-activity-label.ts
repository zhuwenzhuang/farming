export type AcpActivityKind =
  | 'thinking'
  | 'running'
  | 'reading'
  | 'searching'
  | 'editing'
  | 'plan'
  | 'fetching'
  | 'tool'
  | 'processing'

interface AcpActivityItem {
  type?: string
  kind?: string
  status?: string
  title?: string
  completedSteps?: number
  totalSteps?: number
  currentStep?: string
}

function isActive(item: AcpActivityItem) {
  const status = String(item.status || '').trim().replace(/[_-]/g, '').toLowerCase()
  return ['running', 'inprogress', 'pending', 'started', 'active'].includes(status)
}

export function acpActivityKind(items: AcpActivityItem[]): AcpActivityKind {
  const latest = items[items.length - 1]
  const latestType = String(latest?.type || '').toLowerCase()
  if (latestType === 'thought') return 'thinking'

  let item = latest && isActive(latest) ? latest : undefined
  if (!item) {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const candidate = items[index]
      if (candidate && String(candidate.type || '').toLowerCase() !== 'plan' && isActive(candidate)) {
        item = candidate
        break
      }
    }
  }
  if (!item) return 'processing'

  const type = String(item.type || '').toLowerCase()
  const kind = String(item.kind || '').toLowerCase()
  if (kind === 'think') return 'thinking'
  if (type === 'plan') return 'plan'
  if (type === 'patch' || ['edit', 'delete', 'move'].includes(kind)) return 'editing'
  if (kind === 'execute') return 'running'
  if (kind === 'read') return 'reading'
  if (kind === 'search') return 'searching'
  if (kind === 'fetch') return 'fetching'
  if (type === 'tool') return 'tool'
  return 'processing'
}

export function acpLiveToolActivityLabel(
  items: AcpActivityItem[],
  labels: Record<AcpActivityKind, string>,
) {
  return items
    .filter(item => ['tool', 'patch', 'subagent'].includes(String(item.type || '').toLowerCase()) && isActive(item))
    .map(item => {
      const activity = labels[acpActivityKind([item])]
      const title = String(item.title || '').trim().replace(/\s+/g, ' ')
      return title ? `${activity}: ${title}` : activity
    })
    .join(' · ')
}

export function acpPlanProgress(items: AcpActivityItem[]) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (!item || String(item.type || '').toLowerCase() !== 'plan' || !isActive(item)) continue
    const completed = Number(item.completedSteps)
    const total = Number(item.totalSteps)
    if (!Number.isInteger(completed) || !Number.isInteger(total) || completed < 0 || total <= 0 || completed > total) {
      return null
    }
    return { completed, total }
  }
  return null
}

export function acpCompactPlanLabel(items: AcpActivityItem[], maxCharacters = 10) {
  const progress = acpPlanProgress(items)
  if (!progress) return ''
  const plan = [...items].reverse().find(item => (
    String(item.type || '').toLowerCase() === 'plan' && isActive(item)
  ))
  const currentStep = String(plan?.currentStep || '').trim().replace(/\s+/g, ' ')
  if (!currentStep) return ''

  const prefix = `${progress.completed}/${progress.total} `
  const available = Math.max(0, maxCharacters - [...prefix].length)
  if (available <= 0) return prefix.trim()
  const characters = [...currentStep]
  const step = characters.length <= available
    ? currentStep
    : `${characters.slice(0, Math.max(1, available - 1)).join('')}…`
  return `${prefix}${step}`
}
