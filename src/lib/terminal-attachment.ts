export interface TerminalAttachmentRecord {
  hostEl: HTMLDivElement
  attachedMount: HTMLElement | null
  attachGeneration: number
  disposed: boolean
}

export function getTerminalSessionParkingLot() {
  let parkingLot = document.getElementById('terminal-session-parking-lot') as HTMLDivElement | null
  if (parkingLot) return parkingLot

  parkingLot = document.createElement('div')
  parkingLot.id = 'terminal-session-parking-lot'
  parkingLot.setAttribute('aria-hidden', 'true')
  parkingLot.style.display = 'none'
  document.body.appendChild(parkingLot)
  return parkingLot
}

export function isTerminalHostAttached(record: TerminalAttachmentRecord) {
  return !record.disposed
    && record.attachedMount !== null
    && record.hostEl.parentElement === record.attachedMount
}

export function isCurrentTerminalAttachment(record: TerminalAttachmentRecord, generation: number) {
  return record.attachGeneration === generation && isTerminalHostAttached(record)
}

export function beginTerminalAttachment(record: TerminalAttachmentRecord) {
  record.attachGeneration += 1
  return record.attachGeneration
}

export function attachTerminalHost(
  record: TerminalAttachmentRecord,
  mountEl: HTMLElement,
  beforeAttach?: () => void,
) {
  if (record.disposed) return false
  beforeAttach?.()

  if (record.hostEl.parentElement !== mountEl) {
    mountEl.replaceChildren(record.hostEl)
  } else {
    Array.from(mountEl.children).forEach(child => {
      if (child !== record.hostEl) child.remove()
    })
  }
  record.attachedMount = mountEl
  return true
}

export function canDetachTerminalHost(record: TerminalAttachmentRecord, expectedMount?: HTMLElement) {
  if (record.disposed) return false
  if (expectedMount && record.attachedMount !== expectedMount) return false
  if (expectedMount && record.hostEl.parentElement !== expectedMount) return false
  return true
}

export function parkTerminalHost(record: TerminalAttachmentRecord) {
  if (record.disposed) return false
  record.attachedMount = null
  record.attachGeneration += 1
  getTerminalSessionParkingLot().appendChild(record.hostEl)
  return true
}
