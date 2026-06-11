import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AdaptiveShell } from '../shell/AdaptiveShell'
import { DeviceScreen } from '../features/device/DeviceScreen'
import { ProfilesScreen } from '../features/profiles/ProfilesScreen'
import { MoodScreen } from '../features/mood/MoodScreen'
import { LibraryScreen } from '../features/library/LibraryScreen'
import { SettingsScreen } from '../features/settings/SettingsScreen'
import { DiagnosticsScreen } from '../features/diagnostics/DiagnosticsScreen'
import { useApplyTheme } from '../device/deviceStore'
import { CommandPalette } from '../components/controls/CommandPalette'

export function AppRoutes() {
  useApplyTheme()

  return (
    <>
      <BrowserRouter>
        <Routes>
          <Route element={<AdaptiveShell />}>
            <Route index element={<Navigate to="/device" replace />} />
            <Route path="/device"      element={<DeviceScreen />} />
            <Route path="/profiles"    element={<ProfilesScreen />} />
            <Route path="/mood"        element={<MoodScreen />} />
            <Route path="/library"     element={<LibraryScreen />} />
            <Route path="/settings"   element={<SettingsScreen />} />
            <Route path="/diagnostics" element={<DiagnosticsScreen />} />
          </Route>
        </Routes>
      </BrowserRouter>
      <CommandPalette />
    </>
  )
}

export default AppRoutes
