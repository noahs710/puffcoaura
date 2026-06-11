// ============================================================
// Puffco device types — mirrors the Lorax protocol
// ============================================================

export type Theme = 'light' | 'dark' | 'auto'
export type Accent = 'teal' | 'violet' | 'pink' | 'orange' | 'cyan' | 'gold'
export type Density = 'compact' | 'comfortable' | 'spacious'
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface Temperature {
  current: number    // current °F
  target: number     // set point °F
  unit: 'F' | 'C'
}

export interface Telemetry {
  temperature: Temperature
  batteryPercent: number
  chamberStatus: 'ready' | 'heating' | 'cooling' | 'idle'
  bucketStatus: 'empty' | 'loaded'
  liveHeat: number      // 0–100
  sessionTime: number   // seconds
  totalDabs: number
  ledBrightness: number // 0–100
  isStealth: boolean
  isBoost: boolean
}

export interface Profile {
  id: string
  name: string
  temp: number       // °F
  time: number        // seconds
  bright: number      // 0–100
  color?: string      // hex
  boostTemp?: number
  boostTime?: number
  isActive?: boolean
}

export interface MoodAnimation {
  id: string
  name: string
  desc: string
  colors: string[]
  tempo: boolean
  tempoBpm?: number
  effect?: 'static' | 'cycle' | 'breathe' | 'wave' | 'spiral'
}

export interface DabSession {
  id: string
  timestamp: number
  duration: number     // seconds
  tempReached: number  // °F
  score: number        // 0–100
  difficulty: 'easy' | 'standard' | 'hard'
}

export interface DeviceInfo {
  name: string
  model: string
  firmwareVersion: string
  macAddress: string
  batteryPercent: number
  chamberCycles: number
  bleSignal: number   // dBm
}

export interface AppSettings {
  theme: Theme
  accent: Accent
  density: Density
  fontSize: 'small' | 'medium' | 'large'
  advancedUser: boolean
  dabEnabled: boolean
  dabDifficulty: 'easy' | 'standard' | 'hard'
  dabThreshold: number
  showLogs: boolean
}

export interface LoraxPath {
  path: number
  name: string
  read?: string   // 'uint8' | 'uint16' | 'uint32' | 'float' | 'bool'
  write?: string
  desc: string
}

export type BleCapability = 'web-bluetooth' | 'bridge-usb' | 'bridge-wifi' | 'none'

export interface BleCapabilityInfo {
  capability: BleCapability
  canWebBle: boolean
  canBridge: boolean
  browser: string
  os: string
}
