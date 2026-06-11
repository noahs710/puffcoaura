// ============================================================
// useIsMobileLayout — true when viewport <= 767px
// Re-evaluates on resize; avoids SSR issues
// ============================================================
import { useState, useEffect } from 'react'

export function useIsMobileLayout(): boolean {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 767)

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)')
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  return isMobile
}
