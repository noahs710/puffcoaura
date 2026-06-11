// ============================================================
// BLE adapter — wraps PuffcoBrowserBleClient for React
// ble-client.js loaded via <script> tag as global window.PuffcoBrowserBleClient
// ============================================================

import { deviceStore } from './deviceStore'
import type { Telemetry, Profile, MoodAnimation, LoraxPath } from './types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BLE = window as any

// BLE client interface — matches the actual class methods
interface BleClientInstance {
  connect(): Promise<void>
  disconnect(): Promise<void>
  startHeat(): Promise<void>
  stopHeat(): Promise<void>
  setBoost(on: boolean): Promise<void>
  setActiveProfile(index: number): Promise<void>
  saveProfile(index: number, patch: Partial<Profile>): Promise<void>
  getProfiles(): Promise<Record<string, unknown>[]>
  readAll(): Promise<Record<string, unknown>>
  setLantern(on: boolean): Promise<void>
  setLanternBrightness(bright: number): Promise<void>
  setMoodAnimation(mood: { colors: string[]; tempo: boolean; effect?: string }): Promise<void>
  setBrightness(bright: number): Promise<void>
  setStealth(on: boolean): Promise<void>
  discoverLoraxPaths(): Promise<LoraxPath[]>
  readLoraxPath(path: number): Promise<number>
  writeLoraxPath(path: number, value: number): Promise<void>
  onDisconnected: (() => void) | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asClient(x: any): BleClientInstance {
  return x as unknown as BleClientInstance
}

class BleAdapter {
  private client: BleClientInstance | null = null

  async connect(): Promise<void> {
    if (!('bluetooth' in navigator)) {
      deviceStore.addLog('error', 'Web Bluetooth not available in this browser')
      return
    }

    deviceStore.setConnectionStatus('connecting')
    deviceStore.addLog('info', 'Connecting to Puffco device…')

    try {
      const Constructor = BLE.PuffcoBrowserBleClient
      this.client = asClient(new Constructor())
      this.client.onDisconnected = () => {
        deviceStore.setConnectionStatus('disconnected')
        deviceStore.addLog('warn', 'Device disconnected')
      }

      await this.client.connect()

      deviceStore.setConnectionStatus('connected')
      deviceStore.addLog('info', 'Connected')

      await this.fetchTelemetry()
      await this.fetchProfiles()
      await this.fetchLoraxPaths()
    } catch (err) {
      deviceStore.setConnectionStatus('error')
      deviceStore.addLog('error', `Connection failed: ${err}`)
    }
  }

  async disconnect(): Promise<void> {
    await this.client?.disconnect()
    this.client = null
    deviceStore.setConnectionStatus('disconnected')
  }

  private pollInterval: ReturnType<typeof setInterval> | null = null

  startPolling(intervalMs = 2000) {
    this.stopPolling()
    this.pollInterval = setInterval(() => { this.fetchTelemetry().catch(() => {}) }, intervalMs)
  }

  stopPolling() {
    if (this.pollInterval) { clearInterval(this.pollInterval); this.pollInterval = null }
  }

  async fetchTelemetry(): Promise<void> {
    if (!this.client) return
    try {
      const data = await this.client.readAll()
      const t: Telemetry = {
        temperature: { current: Number(data.temp) || 0, target: Number(data.targetTemp) || 0, unit: 'F' },
        batteryPercent: Number(data.battery) || 0,
        chamberStatus: data.isHeating ? 'heating' : 'cooling',
        bucketStatus: data.bucketLoaded ? 'loaded' : 'empty',
        liveHeat: Number(data.liveHeat) || 0,
        sessionTime: Number(data.sessionTime) || 0,
        totalDabs: Number(data.totalDabs) || 0,
        ledBrightness: Number(data.ledBrightness) || 100,
        isStealth: Boolean(data.isStealth),
        isBoost: Boolean(data.isBoost),
      }
      deviceStore.setTelemetry(t)
    } catch { /* noop */ }
  }

  async fetchProfiles(): Promise<void> {
    if (!this.client) return
    try {
      const raw = await this.client.getProfiles()
      const profiles: Profile[] = (raw || []).map((p: Record<string, unknown>, i: number) => ({
        id: String(i),
        name: String(p.name || `Profile ${i + 1}`),
        temp: Number(p.temp || 450),
        time: Number(p.time || 30),
        bright: Number(p.bright || 50),
        color: String(p.color || '#34d3c0'),
        isActive: i === 0,
      }))
      deviceStore.setProfiles(profiles)
    } catch { /* noop */ }
  }

  async setProfile(index: number): Promise<void> {
    await this.client?.setActiveProfile(index)
    deviceStore.setActiveProfile(index)
  }

  async saveProfile(index: number, patch: Partial<Profile>): Promise<void> {
    deviceStore.updateProfile(index, patch)
    await this.client?.saveProfile(index, patch)
  }

  async startHeat(): Promise<void> { await this.client?.startHeat(); deviceStore.addLog('info', 'Heat started') }
  async stopHeat(): Promise<void> { await this.client?.stopHeat(); deviceStore.addLog('info', 'Heat stopped') }
  async setBoost(on: boolean): Promise<void> { await this.client?.setBoost(on); deviceStore.addLog('info', `Boost ${on ? 'on' : 'off'}`) }

  async setLanternBrightness(bright: number): Promise<void> {
    deviceStore.setLanternBrightness(bright)
    await this.client?.setLanternBrightness(bright)
  }

  async setMoodAnimation(mood: MoodAnimation): Promise<void> {
    deviceStore.setActiveMood(mood)
    await this.client?.setMoodAnimation({ colors: mood.colors, tempo: mood.tempo, effect: mood.effect })
  }

  async setBrightness(bright: number): Promise<void> { await this.client?.setBrightness(bright) }
  async setStealth(on: boolean): Promise<void> { await this.client?.setStealth(on) }

  async fetchLoraxPaths(): Promise<void> {
    try {
      const paths: LoraxPath[] = await this.client?.discoverLoraxPaths() || []
      deviceStore.setLoraxPaths(paths)
    } catch { /* noop */ }
  }

  async readLoraxPath(path: number): Promise<number> {
    return (await this.client?.readLoraxPath(path)) ?? 0
  }

  async writeLoraxPath(path: number, value: number): Promise<void> {
    await this.client?.writeLoraxPath(path, value)
  }
}

export const bleAdapter = new BleAdapter()

export function detectBleCapability(): { capability: 'web-bluetooth' | 'bridge-usb' | 'bridge-wifi' | 'none' } {
  if ('bluetooth' in navigator) return { capability: 'web-bluetooth' }
  if (/electron/i.test(navigator.userAgent)) return { capability: 'bridge-usb' }
  return { capability: 'none' }
}
