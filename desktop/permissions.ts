export interface DesktopMediaPermissionInput {
  gatewayOrigin: string
  isMainFrame: boolean
  mediaType?: 'video' | 'audio' | 'unknown'
  mediaTypes?: Array<'video' | 'audio'>
  permission: string
  requestingOrigin: string
}
function normalizedOrigin(value: string) {
  try {
    return new URL(value).origin
  } catch {
    return ''
  }
}

export function allowsDesktopAudioPermission(input: DesktopMediaPermissionInput) {
  if (
    input.permission !== 'media'
    || input.isMainFrame !== true
    || normalizedOrigin(input.requestingOrigin) !== normalizedOrigin(input.gatewayOrigin)
  ) return false

  if (input.mediaType) return input.mediaType === 'audio'
  return Boolean(
    input.mediaTypes?.length
    && input.mediaTypes.every(mediaType => mediaType === 'audio'),
  )
}
