const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:'])

function parsedCredentialFreeUrl(value: string) {
  try {
    const url = new URL(value)
    return url.username || url.password ? null : url
  } catch {
    return null
  }
}

/**
 * Returns a normalized URL only for destinations that Desktop may hand to the
 * operating system. File, data, custom-protocol, and credential-bearing URLs
 * must remain outside the Desktop renderer and native-shell boundary.
 */
export function desktopExternalUrl(value: string) {
  const url = parsedCredentialFreeUrl(value)
  if (!url || !EXTERNAL_PROTOCOLS.has(url.protocol)) return null
  return url.toString()
}

/**
 * A credential-bearing URL is never an internal renderer destination, even
 * when its parsed origin otherwise matches the authenticated Desktop gateway.
 */
export function isDesktopGatewayUrl(value: string, gatewayOrigin: string) {
  const url = parsedCredentialFreeUrl(value)
  return Boolean(url && url.origin === gatewayOrigin)
}
