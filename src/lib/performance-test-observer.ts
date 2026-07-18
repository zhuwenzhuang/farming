type PerformanceRenderSurface = 'app' | 'codeWorkspace'

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
}

function installPerformanceTestApi() {
  if (typeof window === 'undefined' || !window.__FARMING_E2E__ || window.__farmingPerformanceTest) return
  window.__farmingPerformanceTest = {
    reset() {
      renderCounts.app = 0
      renderCounts.codeWorkspace = 0
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
