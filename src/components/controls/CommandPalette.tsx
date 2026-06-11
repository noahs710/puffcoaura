// ============================================================
// CommandPalette — Cmd/Ctrl+K, keyboard-driven command launcher
// ============================================================
import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { bleAdapter } from '../../device/bleAdapter'

interface Command {
  id: string
  label: string
  shortcut?: string
  action: () => void | Promise<void>
  group: string
}

export function CommandPalette() {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const commands: Command[] = [
    { id: 'device', label: 'Go to Device', shortcut: '1', action: () => navigate('/device'), group: 'Navigation' },
    { id: 'profiles', label: 'Go to Profiles', shortcut: '2', action: () => navigate('/profiles'), group: 'Navigation' },
    { id: 'mood', label: 'Go to Mood', shortcut: '3', action: () => navigate('/mood'), group: 'Navigation' },
    { id: 'library', label: 'Go to Library', shortcut: '4', action: () => navigate('/library'), group: 'Navigation' },
    { id: 'settings', label: 'Go to Settings', shortcut: '5', action: () => navigate('/settings'), group: 'Navigation' },
    { id: 'startHeat', label: 'Start Heat', shortcut: 'Space', action: () => bleAdapter.startHeat(), group: 'Device' },
    { id: 'stopHeat', label: 'Stop Heat', shortcut: 'Space', action: () => bleAdapter.stopHeat(), group: 'Device' },
    { id: 'boost', label: 'Toggle Boost', shortcut: 'B', action: () => bleAdapter.setBoost(true), group: 'Device' },
    { id: 'reconnect', label: 'Reconnect Device', action: async () => { await bleAdapter.disconnect(); await bleAdapter.connect() }, group: 'Device' },
  ]

  const filtered = query
    ? commands.filter((c) => c.label.toLowerCase().includes(query.toLowerCase()))
    : commands

  const groups = filtered.reduce<Record<string, Command[]>>((acc, c) => {
    if (!acc[c.group]) acc[c.group] = []
    acc[c.group].push(c)
    return acc
  }, {})

  function openPalette() {
    setOpen(true)
    setQuery('')
    setTimeout(() => inputRef.current?.focus(), 50)
  }

  function closePalette() {
    setOpen(false)
    setQuery('')
  }

  async function run(cmd: Command) {
    closePalette()
    await cmd.action()
  }

  // Global keyboard shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        open ? closePalette() : openPalette()
      }
      if (e.key === 'Escape' && open) closePalette()
      // Number shortcuts for tabs
      if (!open && !e.metaKey && !e.ctrlKey && !e.altKey && e.target instanceof HTMLInputElement === false) {
        const num = parseInt(e.key)
        if (num >= 1 && num <= 5) {
          const routes = ['/device', '/profiles', '/mood', '/library', '/settings']
          navigate(routes[num - 1])
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open])

  if (!open) {
    return (
      <button
        className="command-palette-trigger desktop-only"
        onClick={openPalette}
        title="Command palette (Ctrl+K)"
        style={{
          position: 'fixed', bottom: '16px', right: '16px',
          width: '40px', height: '40px', borderRadius: '50%',
          background: 'var(--bg-card)', border: '1px solid var(--border-medium)',
          color: 'var(--text-muted)', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '18px',
        }}
      >
        ⌘
      </button>
    )
  }

  return (
    <>
      <div className="dialog-backdrop" onClick={closePalette} />
      <div
        className="command-palette"
        style={{
          position: 'fixed',
          top: '20%',
          left: '50%',
          transform: 'translateX(-50%)',
          width: 'min(560px, 90vw)',
          background: 'var(--bg-card)',
          border: '1px solid var(--border-medium)',
          borderRadius: 'var(--radius-panel)',
          boxShadow: 'var(--shadow-dialog)',
          zIndex: 600,
          overflow: 'hidden',
        }}
      >
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
          <input
            ref={inputRef}
            className="input"
            placeholder="Type a command…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ border: 'none', background: 'transparent', fontSize: '1rem', padding: '4px 0' }}
          />
        </div>
        <div style={{ maxHeight: '360px', overflowY: 'auto', padding: '8px' }}>
          {Object.entries(groups).map(([group, cmds]) => (
            <div key={group} style={{ marginBottom: '8px' }}>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', fontWeight: 600, padding: '4px 8px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                {group}
              </div>
              {cmds.map((cmd) => (
                <button
                  key={cmd.id}
                  onClick={() => run(cmd)}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '10px 12px', border: 'none', borderRadius: '8px',
                    background: 'transparent', color: 'var(--text-primary)',
                    fontFamily: 'var(--font)', fontSize: 'var(--font-size-base)', cursor: 'pointer',
                    textAlign: 'left',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-glass-hover)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <span>{cmd.label}</span>
                  {cmd.shortcut && (
                    <kbd style={{ background: 'var(--bg-glass)', borderRadius: '4px', padding: '2px 6px', fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
                      {cmd.shortcut}
                    </kbd>
                  )}
                </button>
              ))}
            </div>
          ))}
          {filtered.length === 0 && (
            <p style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '24px' }}>No commands found</p>
          )}
        </div>
      </div>
    </>
  )
}
