import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MobileQrLoadStatus } from '../src/components/code/MobileShareSheet'

test('renders an explicit mobile QR renderer failure with a retry action', () => {
  const markup = renderToStaticMarkup(
    createElement(MobileQrLoadStatus, {
      failed: true,
      loadingLabel: 'Loading',
      failedLabel: 'Share link unavailable',
      retryLabel: 'Retry',
      onRetry: () => {},
    }),
  )

  assert.match(markup, /role="status"/)
  assert.match(markup, /Share link unavailable/)
  assert.match(markup, /data-testid="code-mobile-share-qr-retry"/)
  assert.match(markup, />Retry<\/button>/)
  assert.doesNotMatch(markup, /Loading/)
})

test('renders loading without a retry action before a failure', () => {
  const markup = renderToStaticMarkup(
    createElement(MobileQrLoadStatus, {
      failed: false,
      loadingLabel: 'Loading',
      failedLabel: 'Share link unavailable',
      retryLabel: 'Retry',
      onRetry: () => {},
    }),
  )

  assert.match(markup, /role="status"/)
  assert.match(markup, /Loading/)
  assert.doesNotMatch(markup, /code-mobile-share-qr-retry/)
})
