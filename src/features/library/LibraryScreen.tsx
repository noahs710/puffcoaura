// ============================================================
// LibraryScreen — dab history + import/export
// ============================================================
import { useDeviceStore, store } from '../../device/deviceStore'
import { useIsMobileLayout } from '../../components/ui/useIsMobileLayout'

export function LibraryScreen() {
  const isMobile = useIsMobileLayout()
  const sessions = useDeviceStore((s) => s.dabSessions)
  const profiles = useDeviceStore((s) => s.profiles)
  const settings = useDeviceStore((s) => s.settings)

  function exportLibrary() {
    const data = {
      profiles,
      dabSessions: sessions,
      exportedAt: new Date().toISOString(),
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `puffco-library-${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  function importLibrary() {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      try {
        const text = await file.text()
        const data = JSON.parse(text)
        if (data.profiles) store.setProfiles(data.profiles)
        if (data.dabSessions) data.dabSessions.forEach((s: unknown) => store.addDabSession(s as Parameters<typeof store.addDabSession>[0]))
      } catch { alert('Invalid library file') }
    }
    input.click()
  }

  const recentDabs = sessions.slice(0, 10)

  return (
    <div className="library-screen stack">
      <div className="screen-header">
        <h2>Library</h2>
        <div className="row" style={{ gap: '8px' }}>
          <button className="btn btn-ghost" onClick={importLibrary}>Import</button>
          <button className="btn btn-primary" onClick={exportLibrary}>Export</button>
        </div>
      </div>

      {/* Dab history */}
      <section className="card">
        <div className="card-header">
          <span className="card-title">Dab History</span>
          {settings.dabEnabled && <span style={{ color: 'var(--accent)', fontSize: 'var(--font-size-sm)' }}>{sessions.length} sessions</span>}
        </div>
        {!settings.dabEnabled ? (
          <p style={{ color: 'var(--text-muted)' }}>
            Dab scoring is disabled.{' '}
              <button className="btn btn-ghost" style={{ display: 'inline', padding: '2px 8px', minHeight: '28px', fontSize: 'inherit' }}
              onClick={() => store.updateSettings({ dabEnabled: true })}>
              </button>
          </p>
        ) : recentDabs.length === 0 ? (
          <p style={{ color: 'var(--text-muted)' }}>No sessions yet. Start heating to begin scoring.</p>
        ) : (
          <div className={isMobile ? 'stack' : 'grid-2'}>
            {recentDabs.map((s, i) => (
              <div key={s.id ?? i} className="dab-session-card">
                <div className="dab-score" style={{ color: scoreColor(s.score) }}>{s.score}</div>
                <div>
                  <div style={{ fontWeight: 600 }}>{new Date(s.timestamp).toLocaleString()}</div>
                  <div style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
                    {s.duration}s · {s.tempReached}°F · {s.difficulty}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Saved profiles */}
      <section className="card">
        <div className="card-header">
          <span className="card-title">Saved Profiles</span>
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>{profiles.length} profiles</span>
        </div>
        {profiles.length === 0 ? (
          <p style={{ color: 'var(--text-muted)' }}>No profiles yet.</p>
        ) : (
          <div className="stack" style={{ marginTop: '8px' }}>
            {profiles.map((p, i) => (
              <div key={p.id ?? i} className="profile-row">
                <div style={{ fontWeight: 600 }}>{p.name}</div>
                <div style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
                  {p.temp}°F · {p.time}s
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function scoreColor(score: number): string {
  if (score >= 80) return 'var(--accent-green)'
  if (score >= 50) return 'var(--accent-gold)'
  return 'var(--dot-error)'
}
