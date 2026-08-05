export function planDetailItems(detail: string) {
  const lines = detail.split('\n').map(line => line.trim()).filter(Boolean)
  const parsed = lines.map(line => {
    const match = line.match(/^\[(x|>| )\]\s+(.+)$/i)
    if (!match) return null
    const marker = (match[1] || '').toLowerCase()
    return {
      status: marker === 'x' ? 'completed' : marker === '>' ? 'running' : 'pending',
      text: match[2] || '',
    }
  })
  if (parsed.some(item => item === null)) return null
  return parsed as Array<{ status: 'completed' | 'running' | 'pending'; text: string }>
}
