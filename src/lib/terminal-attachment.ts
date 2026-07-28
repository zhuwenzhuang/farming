export interface TerminalAttachmentRecord {
  hostEl: HTMLDivElement
  attachedMount: HTMLElement | null
  attachGeneration: number
  disposed: boolean
}

export interface TerminalAttachmentLease {
  release: () => void
}

interface TerminalAttachmentLeaseEntry {
  agentId: string
  mountEl: HTMLElement
  revision: number
  releasePending: boolean
  teardown: () => void
}

type TerminalAttachmentReleaseScheduler = (commit: () => void) => void

/**
 * React may clean up and recreate an effect in the same commit even though the
 * terminal's business owner did not change. This coordinator turns that
 * implementation detail into an ownership handoff: a same-owner reacquire
 * cancels the pending release and reuses the existing attachment.
 */
export function createTerminalAttachmentLeaseCoordinator(
  scheduleRelease: TerminalAttachmentReleaseScheduler = queueMicrotask,
) {
  let current: TerminalAttachmentLeaseEntry | null = null
  let nextRevision = 0

  const createLease = (entry: TerminalAttachmentLeaseEntry): TerminalAttachmentLease => {
    const revision = entry.revision
    let released = false

    return {
      release: () => {
        if (released) return
        released = true
        if (current !== entry || entry.revision !== revision) return

        entry.releasePending = true
        scheduleRelease(() => {
          if (
            current !== entry
            || entry.revision !== revision
            || !entry.releasePending
          ) {
            return
          }
          current = null
          entry.releasePending = false
          entry.teardown()
        })
      },
    }
  }

  return {
    acquire(
      agentId: string,
      mountEl: HTMLElement,
      start: () => () => void,
    ): TerminalAttachmentLease {
      if (current?.agentId === agentId && current.mountEl === mountEl) {
        current.releasePending = false
        current.revision = ++nextRevision
        return createLease(current)
      }

      if (current) {
        const previous = current
        current = null
        previous.releasePending = false
        previous.teardown()
      }

      const entry: TerminalAttachmentLeaseEntry = {
        agentId,
        mountEl,
        revision: ++nextRevision,
        releasePending: false,
        teardown: start(),
      }
      current = entry
      return createLease(entry)
    },
  }
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
