import {
  applyDesktopBackendChange,
  type DesktopBackendActivationState,
} from './backend-activation-state.js'

interface SavedDesktopBackend {
  id: string
}

export interface DesktopSaveAndActivateOperations<T extends SavedDesktopBackend> {
  activations: DesktopBackendActivationState
  activeBackendId: string | null
  editingBackendId?: string
  save: () => T
  disconnect: (backendId: string) => void
  closeActiveClientConnections: () => void
  broadcastState: () => void
  connect: (backendId: string) => Promise<void>
  assertRunning: () => void
  setActiveBackendId: (backendId: string) => void
  requestRendererNavigation: () => void
}

export async function saveAndActivateDesktopBackend<T extends SavedDesktopBackend>(
  operations: DesktopSaveAndActivateOperations<T>,
) {
  const saved = operations.save()
  if (operations.editingBackendId) {
    applyDesktopBackendChange(
      operations.activations,
      saved.id,
      operations.activeBackendId,
      {
        disconnect: () => operations.disconnect(saved.id),
        invalidateActiveRoute: operations.closeActiveClientConnections,
      },
    )
  }
  operations.broadcastState()

  const activation = operations.activations.begin(saved.id)
  try {
    await operations.connect(saved.id)
    operations.assertRunning()
  } catch (error) {
    operations.activations.cancel(activation)
    throw error
  }
  if (!operations.activations.claim(activation)) return saved

  operations.setActiveBackendId(saved.id)
  operations.broadcastState()
  operations.requestRendererNavigation()
  return saved
}
