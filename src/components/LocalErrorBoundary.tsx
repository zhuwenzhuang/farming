import {
  Component,
  type ErrorInfo,
  type ReactNode,
} from 'react'

type LocalErrorBoundaryFallback = (error: unknown, retry: () => void) => ReactNode

interface LocalErrorBoundaryProps {
  children: ReactNode
  fallback: LocalErrorBoundaryFallback
  label: string
  resetKey: string
}

interface LocalErrorBoundaryState {
  failed: boolean
  error: unknown
}

export class LocalErrorBoundary extends Component<LocalErrorBoundaryProps, LocalErrorBoundaryState> {
  state: LocalErrorBoundaryState = { failed: false, error: null }

  static getDerivedStateFromError(error: unknown): LocalErrorBoundaryState {
    return { failed: true, error }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`Farming ${this.props.label} render failed`, error, info)
  }

  componentDidUpdate(previousProps: LocalErrorBoundaryProps) {
    if (this.state.failed && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ failed: false, error: null })
    }
  }

  private retry = () => {
    this.setState({ failed: false, error: null })
  }

  render() {
    if (this.state.failed) return this.props.fallback(this.state.error, this.retry)
    return this.props.children
  }
}

type LocalRenderFaultSurface =
  | 'file-markdown'
  | 'file-preview'
  | 'transcript-markdown'
  | 'transcript-mermaid'
  | 'transcript-tool'
  | 'transcript-turn'

declare global {
  interface Window {
    __FARMING_E2E__?: boolean
    __farmingLocalRenderFaults?: string[]
  }
}

export function LocalRenderFault({
  children,
  identity,
  surface,
}: {
  children: ReactNode
  identity: string
  surface: LocalRenderFaultSurface
}) {
  if (typeof window !== 'undefined' && window.__FARMING_E2E__) {
    const faults = window.__farmingLocalRenderFaults
    if (faults?.includes(surface) || faults?.includes(`${surface}:${identity}`)) {
      throw new Error(`Injected ${surface} render failure`)
    }
  }
  return children
}
