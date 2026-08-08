export function visibleUrlWithoutToken(value: string): string | null {
  const url = new URL(value)
  if (!url.searchParams.has('token')) return null
  url.searchParams.delete('token')
  return `${url.pathname}${url.search}${url.hash}`
}
