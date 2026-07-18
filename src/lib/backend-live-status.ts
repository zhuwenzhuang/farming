import { useSyncExternalStore } from 'react'
import type { SystemStats } from '@/types/agent'

export interface BackendConnectionSnapshot {
  connected: boolean
  everConnected: boolean
  lastMessageAt: number
}

type Listener = () => void

let connectionSnapshot: BackendConnectionSnapshot = {
  connected: false,
  everConnected: false,
  lastMessageAt: Date.now(),
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
    everConnected: false,
    lastMessageAt: Date.now(),
  }
  notify(connectionListeners)
}

export function updateBackendConnectionStatus(patch: Partial<BackendConnectionSnapshot>) {
  const next = { ...connectionSnapshot, ...patch }
  if (
    next.connected === connectionSnapshot.connected
    && next.everConnected === connectionSnapshot.everConnected
    && next.lastMessageAt === connectionSnapshot.lastMessageAt
  ) return
  connectionSnapshot = next
  notify(connectionListeners)
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
