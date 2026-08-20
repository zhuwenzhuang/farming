import { useSyncExternalStore } from 'react'
import type { SystemStats } from '@/types/agent'

export interface BackendConnectionSnapshot {
  connected: boolean
  reconnecting: boolean
  everConnected: boolean
  lastMessageAt: number
  disconnectedAt: number | null
  businessStatus: 'checking' | 'ready' | 'recovering' | 'failed' | 'stopping' | 'unresponsive'
  businessCheckedAt: number | null
  businessServerEpoch: string
}

type Listener = () => void

let connectionSnapshot: BackendConnectionSnapshot = {
  connected: false,
  reconnecting: false,
  everConnected: false,
  lastMessageAt: Date.now(),
  disconnectedAt: Date.now(),
  businessStatus: 'checking',
  businessCheckedAt: null,
  businessServerEpoch: '',
}
let systemStatsSnapshot: SystemStats | null = null

const connectionListeners = new Set<Listener>()
const systemStatsListeners = new Set<Listener>()

function subscribe(listeners: Set<Listener>, listener: Listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notify(listeners: Set<Listener>) {
  listeners.forEach(listener => listener())
}

export function resetBackendConnectionStatus() {
  connectionSnapshot = {
    connected: false,
    reconnecting: false,
    everConnected: false,
    lastMessageAt: Date.now(),
    disconnectedAt: Date.now(),
    businessStatus: 'checking',
    businessCheckedAt: null,
    businessServerEpoch: '',
  }
  notify(connectionListeners)
}

export function updateBackendConnectionStatus(patch: Partial<BackendConnectionSnapshot>) {
  const next = { ...connectionSnapshot, ...patch }
  if (
    next.connected === connectionSnapshot.connected
    && next.reconnecting === connectionSnapshot.reconnecting
    && next.everConnected === connectionSnapshot.everConnected
    && next.lastMessageAt === connectionSnapshot.lastMessageAt
    && next.disconnectedAt === connectionSnapshot.disconnectedAt
    && next.businessStatus === connectionSnapshot.businessStatus
    && next.businessCheckedAt === connectionSnapshot.businessCheckedAt
    && next.businessServerEpoch === connectionSnapshot.businessServerEpoch
  ) return
  connectionSnapshot = next
  notify(connectionListeners)
}

export function markBackendDisconnected(disconnectedAt = Date.now()) {
  updateBackendConnectionStatus({
    connected: false,
    // Preserve the beginning of one continuous outage. Failed reconnects can
    // close once per second; moving this timestamp on every close would keep
    // the UI inside its initial grace period forever.
    disconnectedAt: connectionSnapshot.connected || connectionSnapshot.disconnectedAt === null
      ? disconnectedAt
      : connectionSnapshot.disconnectedAt,
  })
}

export function getBackendConnectionSnapshot() {
  return connectionSnapshot
}

export function subscribeBackendConnectionStatus(listener: Listener) {
  return subscribe(connectionListeners, listener)
}

export function useBackendConnectionStatus() {
  return useSyncExternalStore(
    subscribeBackendConnectionStatus,
    getBackendConnectionSnapshot,
    getBackendConnectionSnapshot,
  )
}

export function updateBackendSystemStats(systemStats: SystemStats | null) {
  if (systemStatsSnapshot === systemStats) return
  systemStatsSnapshot = systemStats
  notify(systemStatsListeners)
}

export function getBackendSystemStatsSnapshot() {
  return systemStatsSnapshot
}

function subscribeBackendSystemStats(listener: Listener) {
  return subscribe(systemStatsListeners, listener)
}

function hasBackendSystemStatsSnapshot() {
  return systemStatsSnapshot !== null
}

export function useBackendSystemStats() {
  return useSyncExternalStore(
    subscribeBackendSystemStats,
    getBackendSystemStatsSnapshot,
    getBackendSystemStatsSnapshot,
  )
}

export function useHasBackendSystemStats() {
  return useSyncExternalStore(
    subscribeBackendSystemStats,
    hasBackendSystemStatsSnapshot,
    hasBackendSystemStatsSnapshot,
  )
}
