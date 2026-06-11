// ============================================================
// Puffco device state store — simple pub/sub with React hook
// ============================================================

import type {
  Telemetry,
  Profile,
  MoodAnimation,
  DabSession,
  DeviceInfo,
  AppSettings,
  ConnectionStatus,
  Theme,
  Accent,
  Density,
  LoraxPath,
  BleCapabilityInfo,
} from './types'

// ---- Persistence helpers ----
function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`puffco:${key}`)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch { return fallback }
}

function persist(key: string, value: unknown) {
  try { localStorage.setItem(`puffco:${key}`, JSON.stringify(value)) } catch { /* noop */ }
}

// ---- Settings defaults ----
const DEFAULTS: AppSettings = {
  theme: 'auto', accent: 'teal', density: 'comfortable',
  fontSize: 'medium', advancedUser: false,
  dabEnabled: false, dabDifficulty: 'standard', dabThreshold: 12, showLogs: false,
}

// ---- Store instance ----
type Listener = () => void

class DeviceStore {
  private _listeners = new Set<Listener>()

  connectionStatus: ConnectionStatus = 'disconnected'
  telemetry: Telemetry | null = null
  profiles: Profile[] = []
  activeProfileIndex = -1
  moodAnimations: MoodAnimation[] = []
  activeMood: MoodAnimation | null = null
  lanternOn = false
  lanternBrightness = 100
  dabSessions: DabSession[] = load<DabSession[]>('dab_sessions', [])
  deviceInfo: DeviceInfo | null = null
  settings: AppSettings = { ...DEFAULTS, ...load<AppSettings>('settings', DEFAULTS) }
  loraxPaths: LoraxPath[] = []
  bleCapability: BleCapabilityInfo | null = null
  logs: Array<{ ts: number; level: 'info' | 'warn' | 'error'; msg: string }> = []

  private _notify() { this._listeners.forEach((l) => l()) }

  setConnectionStatus(v: ConnectionStatus) { this.connectionStatus = v; this._notify() }
  setTelemetry(v: Telemetry) { this.telemetry = v; this._notify() }
  setProfiles(v: Profile[]) { this.profiles = v; this._notify() }
  setActiveProfile(i: number) { this.activeProfileIndex = i; this._notify() }
  updateProfile(i: number, patch: Partial<Profile>) {
    const profiles = [...this.profiles]
    profiles[i] = { ...profiles[i], ...patch }
    this.profiles = profiles; this._notify()
  }
  setMoodAnimations(v: MoodAnimation[]) { this.moodAnimations = v; this._notify() }
  setActiveMood(v: MoodAnimation) { this.activeMood = v; this._notify() }
  setLanternOn(v: boolean) { this.lanternOn = v; this._notify() }
  setLanternBrightness(v: number) { this.lanternBrightness = v; this._notify() }
  addDabSession(s: DabSession) {
    const sessions = [s, ...this.dabSessions].slice(0, 100)
    persist('dab_sessions', sessions)
    this.dabSessions = sessions; this._notify()
  }
  setDeviceInfo(v: DeviceInfo) { this.deviceInfo = v; this._notify() }
  updateSettings(patch: Partial<AppSettings>) {
    const settings = { ...this.settings, ...patch }
    persist('settings', settings)
    this.settings = settings; this._notify()
  }
  setLoraxPaths(v: LoraxPath[]) { this.loraxPaths = v; this._notify() }
  setBleCapability(v: BleCapabilityInfo) { this.bleCapability = v; this._notify() }
  addLog(level: 'info' | 'warn' | 'error', msg: string) {
    this.logs = [...this.logs, { ts: Date.now(), level, msg }].slice(-500); this._notify()
  }
  clearLogs() { this.logs = []; this._notify() }

  subscribe(cb: Listener): () => void {
    this._listeners.add(cb)
    return () => { this._listeners.delete(cb) }
  }

  getState() { return this }
}

// Singleton
export const store = new DeviceStore()

// ---- React hook ----
import { useSyncExternalStore, useEffect } from 'react'

export function useDeviceStore<T>(selector: (s: DeviceStore) => T): T {
  return useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => selector(store),
    () => selector(store),
  )
}

// Alias for imperative access
export { store as deviceStore }

// ---- Theme helpers ----
export function applyTheme(theme: Theme, accent: Accent, density: Density) {
  const root = document.documentElement
  const effective = theme === 'auto'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    : theme
  root.setAttribute('data-theme', effective)
  root.setAttribute('data-accent', accent)
  root.setAttribute('data-density', density)
}

export function useApplyTheme() {
  const settings = useDeviceStore((s) => s.settings)
  useEffect(() => {
    applyTheme(settings.theme, settings.accent, settings.density)
  }, [settings.theme, settings.accent, settings.density])
}
