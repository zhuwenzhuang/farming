export function decodeFileUrlPath(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
