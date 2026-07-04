import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles/tokens.css'
import './styles/effects.css'
import './styles/main.css'
import './styles/code-dark.css'

function isExpectedMonacoCancellation(value: unknown) {
  if (!(value instanceof Error)) return false
  const message = `${value.name}: ${value.message}`.toLowerCase()
  const stack = String(value.stack || '').toLowerCase()
  return message === 'error: canceled' || message === 'canceled: canceled'
    ? stack.includes('editor.api') || stack.includes('monaco')
    : false
}

window.addEventListener('error', event => {
  if (isExpectedMonacoCancellation(event.error)) {
    event.preventDefault()
  }
})

window.addEventListener('unhandledrejection', event => {
  if (isExpectedMonacoCancellation(event.reason)) {
    event.preventDefault()
  }
})

createRoot(document.getElementById('root')!).render(
  <App />
)
