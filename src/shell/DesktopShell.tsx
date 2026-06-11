// ============================================================
// DesktopShell — dashboard layout with sidebar + main + inspector
// ============================================================
import { NavLink, Outlet } from 'react-router-dom'
import { useDeviceStore } from '../device/deviceStore'

export function DesktopShell() {
  const status = useDeviceStore((s) => s.connectionStatus)
  const telemetry = useDeviceStore((s) => s.telemetry)
  const deviceInfo = useDeviceStore((s) => s.deviceInfo)
  const advancedUser = useDeviceStore((s) => s.settings.advancedUser)

  const navItems = [
    { path: '/device',     label: 'Device',     icon: DeviceIcon },
    { path: '/profiles',   label: 'Profiles',  icon: ProfilesIcon },
    { path: '/mood',       label: 'Mood',        icon: MoodIcon },
    { path: '/library',   label: 'Library',   icon: LibraryIcon },
    { path: '/settings',  label: 'Settings',  icon: SettingsIcon },
    ...(advancedUser ? [{ path: '/diagnostics', label: 'Advanced', icon: DiagIcon }] : []),
  ]

  return (
    <div className="desktop-shell">
      {/* Left sidebar */}
      <aside className="desktop-sidebar">
        <div className="sidebar-logo">Puffco</div>
        <nav aria-label="App sections">
          {navItems.map(({ path, label, icon: Icon }) => (
            <NavLink
              key={path}
              to={path}
              className={({ isActive }) => `sidebar-item ${isActive ? 'active' : ''}`}
            >
              <Icon />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
      </aside>

      {/* Center workspace */}
      <main className="desktop-main">
        {/* Top bar */}
        <header className="desktop-topbar">
          <div className="topbar-left">
            <span className={`connection-dot ${status === 'connected' ? 'online' : 'offline'}`} />
            <span>{status === 'connected' ? `Connected — ${deviceInfo?.name ?? 'Puffco'}` : 'Disconnected'}</span>
          </div>
          <div className="topbar-right">
            {telemetry && (
              <span className="topbar-temp">{telemetry.temperature.current}°F</span>
            )}
          </div>
        </header>
        {/* Content */}
        <div className="desktop-content">
          <Outlet />
        </div>
      </main>

      {/* Right inspector */}
      <aside className="desktop-inspector">
        <div className="inspector-section">
          <div className="inspector-title">Device Info</div>
          {telemetry ? (
            <dl className="inspector-list">
              <dt>Battery</dt><dd>{telemetry.batteryPercent}%</dd>
              <dt>Chamber</dt><dd>{telemetry.chamberStatus}</dd>
              <dt>Bucket</dt><dd>{telemetry.bucketStatus}</dd>
              <dt>LED Brightness</dt><dd>{telemetry.ledBrightness}%</dd>
              <dt>Stealth</dt><dd>{telemetry.isStealth ? 'On' : 'Off'}</dd>
              <dt>Boost</dt><dd>{telemetry.isBoost ? 'On' : 'Off'}</dd>
              {deviceInfo && <>
                <dt>Firmware</dt><dd>{deviceInfo.firmwareVersion}</dd>
                <dt>Chamber cycles</dt><dd>{deviceInfo.chamberCycles}</dd>
              </>}
            </dl>
          ) : (
            <p className="inspector-empty">Not connected</p>
          )}
        </div>
      </aside>
    </div>
  )
}

// ---- Icons ----
function DeviceIcon() {
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>
}
function ProfilesIcon() {
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
}
function MoodIcon() {
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
}
function LibraryIcon() {
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
}
function SettingsIcon() {
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
}
function DiagIcon() {
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
}
