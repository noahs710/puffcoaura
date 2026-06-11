// Global type declarations for legacy scripts

declare class PuffcoBrowserBleClient {
  device: BluetoothDevice | null
  server: BluetoothRemoteGATTServer | null
  service: BluetoothRemoteGATTService | null
  commandChar: BluetoothRemoteGATTCharacteristic | null
  replyChar: BluetoothRemoteGATTCharacteristic | null
  versionChar: BluetoothRemoteGATTCharacteristic | null
  sequence: number
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>
  commandQueue: Promise<void>
  lastProfiles: unknown[] | null
  onDisconnected: (() => void) | null
  disconnecting: boolean
  drawStrengthSource: unknown

  constructor()
  connect(): Promise<void>
  disconnect(): Promise<void>
  startHeat(): Promise<void>
  stopHeat(): Promise<void>
  setBoost(on: boolean): Promise<void>
  setActiveProfile(index: number): Promise<void>
  saveProfile(index: number, profile: Partial<Profile>): Promise<void>
  getProfiles(): Promise<Record<string, unknown>[]>
  setLantern(on: boolean): Promise<void>
  setLanternBrightness(bright: number): Promise<void>
  setMoodAnimation(mood: { colors: string[]; tempo: boolean; effect?: string }): Promise<void>
  setBrightness(bright: number): Promise<void>
  setStealth(on: boolean): Promise<void>
  discoverLoraxPaths(): Promise<LoraxPath[]>
  readLoraxPath(path: number): Promise<number>
  writeLoraxPath(path: number, value: number): Promise<void>
  readAll(): Promise<Record<string, unknown>>
}

interface Window {
  PuffcoBrowserBleClient: typeof PuffcoBrowserBleClient
}
