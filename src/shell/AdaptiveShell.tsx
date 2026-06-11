// ============================================================
// AdaptiveShell — picks mobile or desktop shell based on layout
// ============================================================
import { useIsMobileLayout } from '../components/ui/useIsMobileLayout'
import { MobileShell } from './MobileShell'
import { DesktopShell } from './DesktopShell'

export function AdaptiveShell() {
  const isMobile = useIsMobileLayout()
  return isMobile ? <MobileShell /> : <DesktopShell />
}
