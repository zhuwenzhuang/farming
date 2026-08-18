type PerformanceRenderSurface =
  | 'app'
  | 'codeWorkspace'
  | 'projectSectionContent'
  | 'fileTreeRow'
  | 'completedTranscriptTurn'
  | 'liveTranscriptTurn'
  | 'completedTranscriptMarkdown'
  | 'liveTranscriptMarkdown'

type PerformanceTestSnapshot = Record<PerformanceRenderSurface, number>

declare global {
  interface Window {
    __FARMING_E2E__?: boolean
    __farmingPerformanceTest?: {
      reset: () => void
      snapshot: () => PerformanceTestSnapshot
    }
  }
}

const renderCounts: PerformanceTestSnapshot = {
  app: 0,
  codeWorkspace: 0,
  projectSectionContent: 0,
  fileTreeRow: 0,
  completedTranscriptTurn: 0,
  liveTranscriptTurn: 0,
  completedTranscriptMarkdown: 0,
  liveTranscriptMarkdown: 0,
}

function installPerformanceTestApi() {
  if (typeof window === 'undefined' || !window.__FARMING_E2E__ || window.__farmingPerformanceTest) return
  window.__farmingPerformanceTest = {
    reset() {
      renderCounts.app = 0
      renderCounts.codeWorkspace = 0
      renderCounts.projectSectionContent = 0
      renderCounts.fileTreeRow = 0
      renderCounts.completedTranscriptTurn = 0
      renderCounts.liveTranscriptTurn = 0
      renderCounts.completedTranscriptMarkdown = 0
      renderCounts.liveTranscriptMarkdown = 0
    },
    snapshot() {
      return { ...renderCounts }
    },
  }
}

export function recordPerformanceTestRender(surface: PerformanceRenderSurface) {
  if (typeof window === 'undefined' || !window.__FARMING_E2E__) return
  installPerformanceTestApi()
  renderCounts[surface] += 1
}
