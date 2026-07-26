import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { createPortal } from 'react-dom'
import {
  BLACK_HOLE_EXIT_SECONDS,
  BLACK_HOLE_MANUAL_EXIT_SECONDS,
  createBlackHolePetRenderer,
  type BlackHolePetRenderer,
} from './black-hole-renderer'

interface BlackHolePetRestSceneProps {
  statusLabel: string
  endLabel: string
  errorLabel: string
  restUntil: number
  active: boolean
  onEnd: () => void
}

const DIGIT_SEGMENTS: Record<string, readonly string[]> = {
  '0': ['a', 'b', 'c', 'd', 'e', 'f'],
  '1': ['b', 'c'],
  '2': ['a', 'b', 'd', 'e', 'g'],
  '3': ['a', 'b', 'c', 'd', 'g'],
  '4': ['b', 'c', 'f', 'g'],
  '5': ['a', 'c', 'd', 'f', 'g'],
  '6': ['a', 'c', 'd', 'e', 'f', 'g'],
  '7': ['a', 'b', 'c'],
  '8': ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
  '9': ['a', 'b', 'c', 'd', 'f', 'g'],
}

function formatRemainingTime(restUntil: number, now: number) {
  const remainingSeconds = Math.max(0, Math.ceil((restUntil - now) / 1000))
  const minutes = Math.floor(remainingSeconds / 60)
  const seconds = remainingSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function SevenSegmentTime({ value }: { value: string }) {
  return (
    <time
      className="code-pet-seven-segment-time"
      aria-label={value}
      dateTime={`PT${value.replace(':', 'M')}S`}
    >
      <span className="code-pet-seven-segment-digits" aria-hidden="true">
        {Array.from(value).map((character, index) => {
          if (character === ':') {
            return (
              <span className="code-pet-seven-segment-colon" key={`colon-${index}`}>
                <i />
                <i />
              </span>
            )
          }
          const litSegments = DIGIT_SEGMENTS[character] ?? []
          return (
            <span className="code-pet-seven-segment-digit" key={`${character}-${index}`}>
              {(['a', 'b', 'c', 'd', 'e', 'f', 'g'] as const).map(segment => (
                <i
                  className={`segment segment-${segment}${litSegments.includes(segment) ? ' lit' : ''}`}
                  key={segment}
                />
              ))}
            </span>
          )
        })}
      </span>
    </time>
  )
}

function createGlassEdgeMap() {
  const width = 520
  const height = 88
  const radius = height / 2
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return null
  const image = context.createImageData(width, height)

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const nearestCapX = x < radius
        ? radius
        : (x > width - radius ? width - radius : x)
      const dx = x - nearestCapX
      const dy = y - radius
      const distanceToCenterLine = Math.sqrt(dx * dx + dy * dy)
      const signedDistance = radius - distanceToCenterLine
      const edgeWeight = Math.max(0, Math.min(1, signedDistance / 11))
      const band = edgeWeight * edgeWeight * (3 - 2 * edgeWeight)
      const normalLength = Math.max(1, distanceToCenterLine)
      const normalX = dx / normalLength
      const normalY = dy / normalLength
      const displacement = (1 - band) * (signedDistance >= 0 ? 1 : 0)
      const offset = (y * width + x) * 4
      image.data[offset] = Math.round(128 + normalX * displacement * 56)
      image.data[offset + 1] = Math.round(128 + normalY * displacement * 56)
      image.data[offset + 2] = 128
      image.data[offset + 3] = 255
    }
  }
  context.putImageData(image, 0, 0)
  return canvas.toDataURL('image/png')
}

export function BlackHolePetRestScene({
  statusLabel,
  endLabel,
  errorLabel,
  restUntil,
  active,
  onEnd,
}: BlackHolePetRestSceneProps) {
  const [now, setNow] = useState(Date.now)
  const [renderError, setRenderError] = useState<string | null>(null)
  const [exiting, setExiting] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const compositorRef = useRef<HTMLCanvasElement>(null)
  const statusMapRef = useRef<SVGFEImageElement>(null)
  const rendererRef = useRef<BlackHolePetRenderer | null>(null)
  const endedRef = useRef(false)
  const statusFilterId = `code-pet-status-glass-${useId().replace(/:/g, '')}`

  useEffect(() => {
    if (!active) return undefined
    setNow(Date.now())
    const interval = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [active, restUntil])

  useEffect(() => {
    const canvas = canvasRef.current
    const compositor = compositorRef.current
    if (!canvas || !compositor) return undefined

    const renderer = createBlackHolePetRenderer({
      canvas,
      compositor,
      homeElement: () => (
        document.querySelector('.code-product-mark')
        ?? document.querySelector('.code-product-pet-anchor')
      ),
      onError: message => setRenderError(message),
    })
    rendererRef.current = renderer
    renderer.setActive(active)
    return () => {
      renderer.destroy()
      rendererRef.current = null
    }
  }, [])

  useEffect(() => {
    rendererRef.current?.setActive(active)
  }, [active])

  useEffect(() => {
    const mapUrl = createGlassEdgeMap()
    if (mapUrl) statusMapRef.current?.setAttribute('href', mapUrl)
  }, [])

  const finish = (
    durationSeconds = BLACK_HOLE_MANUAL_EXIT_SECONDS,
    returnHome = false,
    elapsedSeconds = 0,
  ) => {
    if (endedRef.current) return
    endedRef.current = true
    setExiting(true)
    rendererRef.current?.beginExit(
      onEnd,
      durationSeconds,
      returnHome,
      elapsedSeconds,
    )
  }

  useEffect(() => {
    if (!active) return undefined
    const beginAt = restUntil - BLACK_HOLE_EXIT_SECONDS * 1000
    const timeout = window.setTimeout(
      () => finish(
        BLACK_HOLE_EXIT_SECONDS,
        true,
        Math.max(0, (Date.now() - beginAt) / 1000),
      ),
      Math.max(0, beginAt - Date.now()),
    )
    return () => window.clearTimeout(timeout)
  }, [active, restUntil])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      finish()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  if (typeof document === 'undefined') return null

  const remainingTime = formatRemainingTime(restUntil, now)
  const statusStyle = {
    '--code-pet-status-glass-filter': `url(#${statusFilterId})`,
  } as CSSProperties

  return createPortal(
    <section
      className={`code-pet-black-hole-rest${exiting ? ' exiting' : ''}`}
      data-pet-ui
      data-testid="pet-rest-scene"
      data-pet-appearance="black-hole"
      role="dialog"
      aria-modal="false"
      aria-label={statusLabel}
    >
      <svg className="code-pet-black-hole-filters" aria-hidden="true">
        <defs>
          <filter
            id={statusFilterId}
            x="0%"
            y="0%"
            width="100%"
            height="100%"
            primitiveUnits="objectBoundingBox"
            colorInterpolationFilters="sRGB"
          >
            <feImage
              ref={statusMapRef}
              x="0"
              y="0"
              width="1"
              height="1"
              result="edge-map"
              preserveAspectRatio="none"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="edge-map"
              scale="0.016"
              xChannelSelector="R"
              yChannelSelector="G"
            />
          </filter>
        </defs>
      </svg>
      <canvas
        ref={compositorRef}
        className="code-pet-black-hole-compositor"
        aria-hidden="true"
      />
      <canvas
        ref={canvasRef}
        className="code-pet-black-hole-canvas"
        aria-hidden="true"
      />
      <div className="code-pet-black-hole-status" style={statusStyle}>
        <span className="code-pet-black-hole-status-label">
          {renderError ? errorLabel : statusLabel}
          {!renderError ? <i aria-hidden="true">·</i> : null}
        </span>
        <SevenSegmentTime value={remainingTime} />
        <button type="button" disabled={exiting} onClick={() => finish()}>
          {endLabel}
        </button>
        {renderError ? (
          <span className="code-pet-black-hole-error" title={renderError} aria-hidden="true" />
        ) : null}
      </div>
    </section>,
    document.body,
  )
}
