// ============================================================
// ProfilesScreen — heat profile management
// Mobile: list + bottom sheet editor
// Desktop: list + dialog editor
// ============================================================
import { useDeviceStore } from '../../device/deviceStore'
import { bleAdapter } from '../../device/bleAdapter'
import { useState } from 'react'
import { useIsMobileLayout } from '../../components/ui/useIsMobileLayout'
import type { Profile } from '../../device/types'

export function ProfilesScreen() {
  const isMobile = useIsMobileLayout()
  const profiles = useDeviceStore((s) => s.profiles)
  const activeIndex = useDeviceStore((s) => s.activeProfileIndex)
  const status = useDeviceStore((s) => s.connectionStatus)

  const [editing, setEditing] = useState<Profile | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)

  function openEditor(profile?: Profile) {
    setEditing(profile ?? { id: '', name: 'New Profile', temp: 450, time: 30, bright: 50, color: '#34d3c0' })
    setSheetOpen(true)
  }

  async function handleApply(_profile: Profile, index: number) {
    await bleAdapter.setProfile(index)
  }

  async function handleSave(profile: Profile) {
    const idx = profiles.findIndex((p) => p.id === profile.id)
    if (idx >= 0) {
      await bleAdapter.saveProfile(idx, profile)
    }
    setSheetOpen(false)
    setEditing(null)
  }

  return (
    <div className="profiles-screen stack">
      <div className="screen-header">
        <h2>Profiles</h2>
        {status === 'connected' && (
          <button className="btn btn-primary" onClick={() => openEditor()}>
            + New
          </button>
        )}
      </div>

      {profiles.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '48px' }}>
          {status === 'connected' ? 'No profiles found on device' : 'Connect a device to see profiles'}
        </div>
      ) : (
        <div className={isMobile ? 'stack' : 'grid-3'}>
          {profiles.map((p, i) => (
            <ProfileCard
              key={p.id ?? i}
              profile={p}
              isActive={i === activeIndex}
              onApply={() => handleApply(p, i)}
              onEdit={() => openEditor(p)}
              disabled={status !== 'connected'}
            />
          ))}
        </div>
      )}

      {/* Mobile: bottom sheet editor */}
      {isMobile && sheetOpen && editing && (
        <>
          <div className="sheet-backdrop" onClick={() => setSheetOpen(false)} />
          <div className="sheet">
            <div className="sheet-handle" />
            <div className="sheet-title">{editing.id ? 'Edit Profile' : 'New Profile'}</div>
            <ProfileEditor profile={editing} onSave={handleSave} onCancel={() => setSheetOpen(false)} />
          </div>
        </>
      )}

      {/* Desktop: dialog editor */}
      {!isMobile && sheetOpen && editing && (
        <>
          <div className="dialog-backdrop" onClick={() => setSheetOpen(false)} />
          <div className="dialog">
            <div className="dialog-header">
              <span className="dialog-title">{editing.id ? 'Edit Profile' : 'New Profile'}</span>
              <button className="btn btn-ghost" onClick={() => setSheetOpen(false)}>✕</button>
            </div>
            <div className="dialog-body">
              <ProfileEditor profile={editing} onSave={handleSave} onCancel={() => setSheetOpen(false)} />
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function ProfileCard({ profile, isActive, onApply, onEdit, disabled }: {
  profile: Profile
  isActive: boolean
  onApply: () => void
  onEdit: () => void
  disabled: boolean
}) {
  return (
    <div className={`card profile-card ${isActive ? 'active-profile' : ''}`}>
      <div className="profile-card-header">
        <div>
          <div style={{ fontWeight: 700, fontSize: 'var(--font-size-lg)' }}>{profile.name}</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)', marginTop: '4px' }}>
            {profile.temp}°F · {profile.time}s
          </div>
        </div>
        {isActive && <span className="active-badge">Active</span>}
      </div>
      <div className="profile-card-actions row" style={{ marginTop: '12px', gap: '8px' }}>
        <button className="btn btn-primary" style={{ flex: 1 }} onClick={onApply} disabled={disabled || isActive}>
          Apply
        </button>
        <button className="btn btn-ghost hover-actions" onClick={onEdit} disabled={disabled}>
          Edit
        </button>
      </div>
    </div>
  )
}

function ProfileEditor({ profile, onSave, onCancel }: {
  profile: Profile
  onSave: (p: Profile) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState({ ...profile })

  return (
    <div className="stack" style={{ padding: '0 20px 24px' }}>
      <label className="field-label">Name</label>
      <input
        className="input"
        value={draft.name}
        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        placeholder="Profile name"
      />

      <label className="field-label">Temperature ({draft.temp}°F)</label>
      <input
        type="range"
        min={300} max={600} step={5}
        value={draft.temp}
        onChange={(e) => setDraft({ ...draft, temp: Number(e.target.value) })}
      />

      <label className="field-label">Duration ({draft.time}s)</label>
      <input
        type="range"
        min={10} max={120} step={5}
        value={draft.time}
        onChange={(e) => setDraft({ ...draft, time: Number(e.target.value) })}
      />

      <label className="field-label">Brightness ({draft.bright}%)</label>
      <input
        type="range"
        min={0} max={100} step={5}
        value={draft.bright}
        onChange={(e) => setDraft({ ...draft, bright: Number(e.target.value) })}
      />

      <label className="field-label">Accent Color</label>
      <input
        type="color"
        value={draft.color ?? '#34d3c0'}
        onChange={(e) => setDraft({ ...draft, color: e.target.value })}
        style={{ width: '100%', height: '48px', borderRadius: '12px', border: '1px solid var(--border-subtle)', cursor: 'pointer' }}
      />

      <div className="row" style={{ marginTop: '8px', gap: '12px' }}>
        <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onCancel}>Cancel</button>
        <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => onSave(draft)}>Save</button>
      </div>
    </div>
  )
}
