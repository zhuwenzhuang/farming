import fs from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'
import type { DesktopBackendInput } from '../shared/desktop-contract.js'
import {
  normalizeDesktopBackendInput,
  publicDesktopBackendProfile,
  type StoredDesktopBackendProfile,
} from './profile-model.js'

interface PersistedDesktopState {
  version: 1
  activeBackendId: string | null
  profiles: StoredDesktopBackendProfile[]
}

export interface DesktopRuntimeBackendProfile {
  profile: StoredDesktopBackendProfile
  token: string
}

const EMPTY_STATE: PersistedDesktopState = { version: 1, activeBackendId: null, profiles: [] }

export class DesktopProfileStore {
  private state: PersistedDesktopState
  private readonly runtimeProfiles: Map<string, DesktopRuntimeBackendProfile>

  constructor(
    private readonly stateFile: string,
    runtimeProfiles: DesktopRuntimeBackendProfile[] = [],
  ) {
    this.runtimeProfiles = new Map(runtimeProfiles.map(profile => [profile.profile.id, profile]))
    this.state = this.readState()
  }

  list() {
    return [
      ...Array.from(this.runtimeProfiles.values(), entry => publicDesktopBackendProfile(entry.profile)),
      ...this.state.profiles.map(publicDesktopBackendProfile),
    ]
  }

  getStored(backendId: string) {
    return this.runtimeProfiles.get(backendId)?.profile
      ?? this.state.profiles.find(profile => profile.id === backendId)
      ?? null
  }

  getActiveBackendId() {
    return this.state.activeBackendId
  }

  setActiveBackendId(backendId: string | null) {
    if (backendId !== null && !this.getStored(backendId)) throw new Error('Backend not found.')
    this.state.activeBackendId = backendId
    this.writeState()
  }

  save(input: DesktopBackendInput) {
    if (input.id && this.runtimeProfiles.has(input.id)) throw new Error('Built-in backends cannot be edited.')
    const previous = input.id ? this.getStored(input.id) ?? undefined : undefined
    const profile = normalizeDesktopBackendInput(input, previous)
    if (input.clearToken) {
      profile.encryptedToken = ''
    } else if (input.token?.trim()) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('System credential encryption is not available.')
      }
      profile.encryptedToken = safeStorage.encryptString(input.token.trim()).toString('base64')
    }
    const index = this.state.profiles.findIndex(candidate => candidate.id === profile.id)
    if (index === -1) this.state.profiles.push(profile)
    else this.state.profiles[index] = profile
    if (!this.state.activeBackendId) this.state.activeBackendId = profile.id
    this.writeState()
    return publicDesktopBackendProfile(profile)
  }

  remove(backendId: string) {
    if (this.runtimeProfiles.has(backendId)) throw new Error('Built-in backends cannot be removed.')
    const next = this.state.profiles.filter(profile => profile.id !== backendId)
    if (next.length === this.state.profiles.length) throw new Error('Backend not found.')
    this.state.profiles = next
    if (this.state.activeBackendId === backendId) {
      this.state.activeBackendId = this.runtimeProfiles.keys().next().value ?? next[0]?.id ?? null
    }
    this.writeState()
  }

  readToken(backendId: string) {
    const runtimeToken = this.runtimeProfiles.get(backendId)?.token
    if (runtimeToken !== undefined) return runtimeToken
    const encrypted = this.getStored(backendId)?.encryptedToken
    if (!encrypted) return ''
    if (!safeStorage.isEncryptionAvailable()) throw new Error('System credential encryption is not available.')
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  }

  private readState(): PersistedDesktopState {
    try {
      const value = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as Partial<PersistedDesktopState>
      if (value.version !== 1 || !Array.isArray(value.profiles)) return { ...EMPTY_STATE }
      const profiles = value.profiles.flatMap(profile => {
        try {
          if (!profile || typeof profile !== 'object') return []
          const normalized = normalizeDesktopBackendInput(profile as DesktopBackendInput)
          normalized.encryptedToken = typeof (profile as StoredDesktopBackendProfile).encryptedToken === 'string'
            ? (profile as StoredDesktopBackendProfile).encryptedToken
            : ''
          return [normalized]
        } catch {
          return []
        }
      })
      const activeBackendId = typeof value.activeBackendId === 'string'
        && (this.runtimeProfiles.has(value.activeBackendId) || profiles.some(profile => profile.id === value.activeBackendId))
        ? value.activeBackendId
        : this.runtimeProfiles.keys().next().value ?? profiles[0]?.id ?? null
      return { version: 1, activeBackendId, profiles }
    } catch {
      return { ...EMPTY_STATE }
    }
  }

  private writeState() {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true })
    const temporaryFile = `${this.stateFile}.tmp`
    fs.writeFileSync(temporaryFile, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(temporaryFile, this.stateFile)
    fs.chmodSync(this.stateFile, 0o600)
  }
}
