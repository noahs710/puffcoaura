// ============================================================
// SettingsScreen — all app settings
// ============================================================
import { useDeviceStore } from '../../device/deviceStore'
import { applyTheme } from '../../device/deviceStore'
import type { Theme, Accent, Density } from '../../device/types'

const THEMES: { value: Theme; label: string }[] = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'auto', label: 'Auto' },
]

const ACCENTS: { value: Accent; color: string; label: string }[] = [
  { value: 'teal',   color: '#34d3c0', label: 'Teal' },
  { value: 'violet', color: '#a78bfa', label: 'Violet' },
  { value: 'pink',   color: '#f87171', label: 'Pink' },
  { value: 'orange', color: '#fb923c', label: 'Orange' },
  { value: 'cyan',   color: '#22d3ee', label: 'Cyan' },
  { value: 'gold',   color: '#fbbf24', label: 'Gold' },
]

const DENSITIES: { value: Density; label: string }[] = [
  { value: 'compact', label: 'Compact' },
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'spacious', label: 'Spacious' },
]

export function SettingsScreen() {
  const settings = useDeviceStore((s) => s.settings)
  const update = useDeviceStore((s) => s.updateSettings)

  function handleTheme(t: Theme) {
    update({ theme: t })
    applyTheme(t, settings.accent, settings.density)
  }

  function handleAccent(a: Accent) {
    update({ accent: a })
    applyTheme(settings.theme, a, settings.density)
  }

  function handleDensity(d: Density) {
    update({ density: d })
    applyTheme(settings.theme, settings.accent, d)
  }

  return (
    <div className="settings-screen stack">
      <div className="screen-header">
        <h2>Settings</h2>
      </div>

      {/* Appearance */}
      <section className="card">
        <div className="card-header">
          <span className="card-title">Appearance</span>
        </div>

        <div className="settings-group">
          <label className="settings-label">Theme</label>
          <div className="settings-radio-group">
            {THEMES.map(({ value, label }) => (
              <label key={value} className="settings-radio">
                <input
                  type="radio"
                  name="theme"
                  value={value}
                  checked={settings.theme === value}
                  onChange={() => handleTheme(value)}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="settings-group">
          <label className="settings-label">Accent Color</label>
          <div className="accent-swatches">
            {ACCENTS.map(({ value, color, label }) => (
              <button
                key={value}
                className={`accent-swatch-btn ${settings.accent === value ? 'active' : ''}`}
                style={{ '--swatch': color } as React.CSSProperties}
                onClick={() => handleAccent(value)}
                aria-label={label}
                title={label}
              />
            ))}
          </div>
        </div>

        <div className="settings-group">
          <label className="settings-label">Density</label>
          <div className="settings-radio-group">
            {DENSITIES.map(({ value, label }) => (
              <label key={value} className="settings-radio">
                <input
                  type="radio"
                  name="density"
                  value={value}
                  checked={settings.density === value}
                  onChange={() => handleDensity(value)}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </div>
      </section>

      {/* Dab scoring */}
      <section className="card">
        <div className="card-header">
          <span className="card-title">Dab Scoring</span>
        </div>
        <label className="settings-toggle-row">
          <span>Enable dab scoring</span>
          <label className="toggle">
            <input type="checkbox" checked={settings.dabEnabled} onChange={(e) => update({ dabEnabled: e.target.checked })} />
            <span className="toggle-track" />
          </label>
        </label>
        {settings.dabEnabled && (
          <>
            <div className="settings-group">
              <label className="settings-label">Difficulty</label>
              <div className="settings-radio-group">
                {(['easy', 'standard', 'hard'] as const).map((d) => (
                  <label key={d} className="settings-radio">
                    <input type="radio" name="difficulty" checked={settings.dabDifficulty === d} onChange={() => update({ dabDifficulty: d })} />
                    <span style={{ textTransform: 'capitalize' }}>{d}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="settings-group">
              <label className="settings-label">Heat threshold ({settings.dabThreshold}%)</label>
              <input
                type="range"
                min={1} max={50} step={1}
                value={settings.dabThreshold}
                onChange={(e) => update({ dabThreshold: Number(e.target.value) })}
              />
            </div>
          </>
        )}
      </section>

      {/* Advanced */}
      <section className="card">
        <div className="card-header">
          <span className="card-title">Advanced</span>
        </div>
        <label className="settings-toggle-row">
          <span>Advanced user mode</span>
          <label className="toggle">
            <input type="checkbox" checked={settings.advancedUser} onChange={(e) => update({ advancedUser: e.target.checked })} />
            <span className="toggle-track" />
          </label>
        </label>
        <label className="settings-toggle-row">
          <span>Show debug logs</span>
          <label className="toggle">
            <input type="checkbox" checked={settings.showLogs} onChange={(e) => update({ showLogs: e.target.checked })} />
            <span className="toggle-track" />
          </label>
        </label>
      </section>

      {/* App info */}
      <section className="card">
        <div className="card-header">
          <span className="card-title">About</span>
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
          Puffco Controller v1.0 · Web Bluetooth PWA<br />
          Controls Puffco Peak Pro and Proxy via browser
        </p>
      </section>
    </div>
  )
}
