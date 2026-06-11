// ============================================================
// MoodScreen — lantern / mood lighting controls
// ============================================================
import { useDeviceStore } from '../../device/deviceStore'
import { bleAdapter } from '../../device/bleAdapter'
import { useState } from 'react'

const PRESET_MOODS = [
  { id: 'static', name: 'Static', desc: 'Single solid color', colors: ['#ff0000'], tempo: false, effect: 'static' as const },
  { id: 'dual', name: 'Dual Cycle', desc: 'Two-color alternating', colors: ['#ff0000', '#00ff00'], tempo: true, effect: 'cycle' as const },
  { id: 'rainbow', name: 'Rainbow', desc: 'Full color spectrum', colors: ['#ff0000','#ff7f00','#ffff00','#00ff00','#0000ff','#8b00ff'], tempo: true, effect: 'cycle' as const },
  { id: 'breathe', name: 'Breathe', desc: 'Slow pulsing glow', colors: ['#34d3c0'], tempo: true, effect: 'breathe' as const },
  { id: 'wave', name: 'Wave', desc: 'Rippling light effect', colors: ['#a78bfa','#f87171'], tempo: true, effect: 'wave' as const },
  { id: 'sunset', name: 'Sunset', desc: 'Warm gradient cycle', colors: ['#ff6b6b','#ffa07a','#ffd700'], tempo: true, effect: 'cycle' as const },
]

export function MoodScreen() {
  const telemetry = useDeviceStore((s) => s.telemetry)
  const activeMood = useDeviceStore((s) => s.activeMood)
  const status = useDeviceStore((s) => s.connectionStatus)

  const [brightness, setBrightness] = useState(telemetry?.ledBrightness ?? 100)
  const [selectedMood, setSelectedMood] = useState(activeMood ?? PRESET_MOODS[0])

  async function handleApplyMood(mood: typeof PRESET_MOODS[0]) {
    setSelectedMood(mood)
    await bleAdapter.setMoodAnimation({ ...mood, id: mood.id, name: mood.name })
  }

  async function handleBrightnessChange(val: number) {
    setBrightness(val)
    await bleAdapter.setLanternBrightness(val)
  }

  async function handleToggleLantern() {
    const newVal = !telemetry?.ledBrightness
    await bleAdapter.setLanternBrightness(newVal ? 100 : 0)
  }

  return (
    <div className="mood-screen stack">
      <div className="screen-header">
        <h2>Mood Lighting</h2>
      </div>

      {/* Lantern on/off + brightness */}
      <section className="card">
        <div className="card-header">
          <span className="card-title">Lantern</span>
          <label className="toggle">
            <input
              type="checkbox"
              checked={(telemetry?.ledBrightness ?? 0) > 0}
              onChange={handleToggleLantern}
              disabled={status !== 'connected'}
            />
            <span className="toggle-track" />
          </label>
        </div>
        <label style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)' }}>
          Brightness: {brightness}%
        </label>
        <input
          type="range"
          min={0} max={100} step={5}
          value={brightness}
          onChange={(e) => handleBrightnessChange(Number(e.target.value))}
          disabled={status !== 'connected'}
          style={{ marginTop: '8px' }}
        />
      </section>

      {/* Mood presets */}
      <section className="card">
        <div className="card-header">
          <span className="card-title">Animations</span>
        </div>
        <div className="mood-grid">
          {PRESET_MOODS.map((mood) => (
            <button
              key={mood.id}
              className={`mood-preset-btn ${selectedMood?.id === mood.id ? 'active' : ''}`}
              onClick={() => handleApplyMood(mood)}
              disabled={status !== 'connected'}
              aria-label={mood.name}
            >
              <div className="mood-colors">
                {mood.colors.slice(0, 3).map((c, i) => (
                  <div key={i} style={{ background: c, flex: 1, borderRadius: '4px', minWidth: '16px', height: '32px' }} />
                ))}
              </div>
              <div className="mood-preset-name">{mood.name}</div>
              <div className="mood-preset-desc">{mood.desc}</div>
            </button>
          ))}
        </div>
      </section>

      {/* Color picker — custom mood */}
      <section className="card">
        <div className="card-header">
          <span className="card-title">Custom Color</span>
        </div>
        <div className="row" style={{ gap: '12px', flexWrap: 'wrap' }}>
          {['#ff0000','#ff7f00','#ffff00','#00ff00','#00ffff','#0000ff','#8b00ff','#ff00ff','#ffffff','#34d3c0'].map((c) => (
            <button
              key={c}
              onClick={() => handleApplyMood({ id: 'custom', name: 'Custom', desc: '', colors: [c], tempo: false, effect: 'static' })}
              disabled={status !== 'connected'}
              style={{
                width: '40px', height: '40px', borderRadius: '50%',
                background: c, border: '2px solid var(--border-medium)',
                cursor: 'pointer', flexShrink: 0,
              }}
              aria-label={`Color ${c}`}
            />
          ))}
        </div>
      </section>
    </div>
  )
}
