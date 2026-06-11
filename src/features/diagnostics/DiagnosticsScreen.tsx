// ============================================================
// DiagnosticsScreen — BLE logs, Lorax paths, device registry
// Desktop gets the full view; mobile gets a simpler summary
// ============================================================
import { useDeviceStore, store } from '../../device/deviceStore'
import { bleAdapter } from '../../device/bleAdapter'
import { useState } from 'react'
import type { LoraxPath } from '../../device/types'

export function DiagnosticsScreen() {
  const logs = useDeviceStore((s) => s.logs)
  const loraxPaths = useDeviceStore((s) => s.loraxPaths)
  const settings = useDeviceStore((s) => s.settings)

  const [selectedPath, setSelectedPath] = useState<LoraxPath | null>(null)
  const [pathValue, setPathValue] = useState('')

  async function handleReadPath(path: LoraxPath) {
    setSelectedPath(path)
    try {
      const val = await bleAdapter.readLoraxPath(path.path)
      setPathValue(String(val))
    } catch {
      setPathValue('error')
    }
  }

  async function handleWritePath() {
    if (!selectedPath) return
    try {
      await bleAdapter.writeLoraxPath(selectedPath.path, Number(pathValue))
      setPathValue('written!')
    } catch {
      setPathValue('error')
    }
  }

  if (!settings.advancedUser) {
    return (
      <div className="stack" style={{ padding: '32px', textAlign: 'center' }}>
        <p style={{ color: 'var(--text-muted)' }}>
          Advanced diagnostics are disabled. Enable "Advanced user" in Settings.
        </p>
      </div>
    )
  }

  return (
    <div className="diagnostics-screen stack">
      <div className="screen-header">
        <h2>Diagnostics</h2>
        <button className="btn btn-ghost" onClick={() => store.clearLogs()}>
          Clear Logs
        </button>
      </div>

      {/* Logs panel */}
      <section className="card diagnostics-card">
        <div className="card-header">
          <span className="card-title">BLE Logs</span>
          {settings.showLogs && <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>{logs.length} entries</span>}
        </div>
        <div className="logs-panel">
          {logs.length === 0 ? (
            <p style={{ color: 'var(--text-muted)' }}>No logs yet.</p>
          ) : (
            logs.slice(-50).reverse().map((log, i) => (
              <div key={i} className={`log-entry log-${log.level}`}>
                <span className="log-ts">{new Date(log.ts).toLocaleTimeString()}</span>
                <span className="log-level">{log.level.toUpperCase()}</span>
                <span className="log-msg">{log.msg}</span>
              </div>
            ))
          )}
        </div>
      </section>

      {/* Lorax registry */}
      {loraxPaths.length > 0 && (
        <section className="card diagnostics-card">
          <div className="card-header">
            <span className="card-title">Lorax Registry</span>
            <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>{loraxPaths.length} paths</span>
          </div>
          <div className="lorax-list">
            {loraxPaths.map((p, i) => (
              <div key={i} className="lorax-row">
                <div className="lorax-info">
                  <code className="lorax-path">0x{p.path.toString(16).padStart(4, '0')}</code>
                  <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>{p.name}</span>
                </div>
                <div className="lorax-actions">
                  {p.read && <span className="lorax-cap">R</span>}
                  {p.write && <span className="lorax-cap">W</span>}
                  <button
                    className="btn btn-ghost"
                    style={{ padding: '4px 10px', minHeight: '32px', fontSize: 'var(--font-size-sm)' }}
                    onClick={() => handleReadPath(p)}
                  >
                    Read
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Path read/write */}
      {selectedPath && (
        <section className="card">
          <div className="card-header">
            <span className="card-title">Path 0x{selectedPath.path.toString(16).padStart(4, '0')} — {selectedPath.name}</span>
          </div>
          <div className="row" style={{ gap: '12px', alignItems: 'center' }}>
            <input
              className="input"
              type="number"
              value={pathValue}
              onChange={(e) => setPathValue(e.target.value)}
              placeholder="Value"
              style={{ flex: 1 }}
            />
            {selectedPath.write && (
              <button className="btn btn-primary" onClick={handleWritePath}>Write</button>
            )}
            <button className="btn btn-ghost" onClick={() => setSelectedPath(null)}>Close</button>
          </div>
          <p style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)', marginTop: '8px' }}>
            {selectedPath.desc}
          </p>
        </section>
      )}
    </div>
  )
}
