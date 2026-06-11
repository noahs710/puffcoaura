// ============================================================
// DeviceScreen — main dashboard: temp ring, heat controls,
// connection, active profile, boost
// ============================================================
import { useDeviceStore } from '../../device/deviceStore'
import { bleAdapter } from '../../device/bleAdapter'
import { TempRing } from '../../components/controls/TempRing'
import { HeatButton } from '../../components/controls/HeatButton'
import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

export function DeviceScreen() {
  const navigate = useNavigate()
  const status = useDeviceStore((s) => s.connectionStatus)
  const telemetry = useDeviceStore((s) => s.telemetry)
  const profiles = useDeviceStore((s) => s.profiles)
  const activeIndex = useDeviceStore((s) => s.activeProfileIndex)
  const activeProfile = profiles[activeIndex]

  const [connecting, setConnecting] = useState(false)

  async function handleConnect() {
    setConnecting(true)
    await bleAdapter.connect()
    bleAdapter.startPolling()
    setConnecting(false)
  }

  async function handleDisconnect() {
    bleAdapter.stopPolling()
    await bleAdapter.disconnect()
  }

  async function handleStartHeat() {
    if (status !== 'connected') return
    await bleAdapter.startHeat()
  }

  async function handleStopHeat() {
    await bleAdapter.stopHeat()
  }

  async function handleBoost() {
    if (!telemetry) return
    await bleAdapter.setBoost(!telemetry.isBoost)
  }

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.code === 'Space') { e.preventDefault(); status === 'connected' ? handleStopHeat() : handleStartHeat() }
      if (e.key === 'b' || e.key === 'B') handleBoost()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [status, telemetry])

  return (
    <div className="device-screen stack">
      {/* Connection card */}
      <section className="card connection-card">
        <div className="card-header">
          <span className="card-title">Device</span>
          <div className="row" style={{ gap: '8px' }}>
            <span className={`connection-dot ${status === 'connected' ? 'online' : status === 'connecting' ? 'warning' : 'offline'}`} />
            <span>{status === 'connected' ? 'Connected' : status === 'connecting' ? 'Connecting…' : 'Disconnected'}</span>
          </div>
        </div>
        {status !== 'connected' ? (
          <button
            className="btn btn-primary"
            onClick={handleConnect}
            disabled={connecting}
            style={{ width: '100%', marginTop: '8px' }}
          >
            {connecting ? <><span className="spinner" /> Connecting…</> : 'Connect Device'}
          </button>
        ) : (
          <button
            className="btn btn-ghost"
            onClick={handleDisconnect}
            style={{ width: '100%' }}
          >
            Disconnect
          </button>
        )}
      </section>

      {/* Temperature + heat (only when connected) */}
      {status === 'connected' && telemetry && (
        <>
          {/* Temp ring */}
          <section className="card temp-card">
            <TempRing
              current={telemetry.temperature.current}
              target={telemetry.temperature.target}
              isHeating={telemetry.chamberStatus === 'heating'}
              unit="F"
            />
            <div className="temp-info">
              <div className="temp-target">Target: {telemetry.temperature.target}°F</div>
              <div className="temp-status">
                {telemetry.chamberStatus === 'heating' ? '🔥 Heating' :
                 telemetry.chamberStatus === 'cooling' ? '❄️ Cooling' :
                 telemetry.chamberStatus === 'ready' ? '✓ Ready' : '—'}
              </div>
            </div>
          </section>

          {/* Heat button */}
          <HeatButton
            isHeating={telemetry.chamberStatus === 'heating'}
            onStart={handleStartHeat}
            onStop={handleStopHeat}
          />

          {/* Active profile */}
          {activeProfile && (
            <section className="card">
              <div className="card-header">
                <span className="card-title">Active Profile</span>
                <button className="btn btn-ghost" style={{ padding: '4px 12px', minHeight: '32px' }} onClick={() => navigate('/profiles')}>
                  Change
                </button>
              </div>
              <div className="profile-active-row">
                <div>
                  <div style={{ fontWeight: 700, fontSize: 'var(--font-size-lg)' }}>{activeProfile.name}</div>
                  <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)' }}>
                    {activeProfile.temp}°F · {activeProfile.time}s · {activeProfile.bright}% bright
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* Quick controls row */}
          <div className="grid-2">
            {/* Boost */}
            <section className="card">
              <div className="card-header">
                <span className="card-title">Boost</span>
                <label className="toggle">
                  <input type="checkbox" checked={telemetry.isBoost} onChange={handleBoost} />
                  <span className="toggle-track" />
                </label>
              </div>
              <p style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
                +50°F above target for 30s
              </p>
            </section>

            {/* Lantern preview */}
            <section className="card">
              <div className="card-header">
                <span className="card-title">Lantern</span>
                <span style={{ color: 'var(--accent)' }}>{telemetry.ledBrightness}%</span>
              </div>
              <button className="btn btn-ghost" style={{ width: '100%' }} onClick={() => navigate('/mood')}>
                Mood Controls
              </button>
            </section>
          </div>
        </>
      )}
    </div>
  )
}
