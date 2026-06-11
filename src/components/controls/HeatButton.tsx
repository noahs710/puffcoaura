// ============================================================
// HeatButton — big primary action button
// Mobile: full-width, huge. Desktop: standard.
// ============================================================
import { useState } from 'react'
import { useIsMobileLayout } from '../ui/useIsMobileLayout'

interface Props {
  isHeating: boolean
  onStart: () => void
  onStop: () => void
}

export function HeatButton({ isHeating, onStart, onStop }: Props) {
  const isMobile = useIsMobileLayout()
  const [pressing, setPressing] = useState(false)

  function handleClick() {
    if (isHeating) onStop()
    else onStart()
  }

  return (
    <button
      className={`heat-button ${isHeating ? 'active' : ''} ${pressing ? 'pressing' : ''} ${isMobile ? 'mobile' : 'desktop'}`}
      onClick={handleClick}
      onMouseDown={() => setPressing(true)}
      onMouseUp={() => setPressing(false)}
      onTouchStart={() => setPressing(true)}
      onTouchEnd={() => setPressing(false)}
      aria-label={isHeating ? 'Stop heating' : 'Start heating'}
      style={{
        width: isMobile ? '100%' : '240px',
        height: isMobile ? '72px' : '56px',
        borderRadius: 'var(--radius-button)',
        background: isHeating
          ? 'linear-gradient(135deg, var(--accent-orange), var(--accent-red))'
          : 'var(--accent)',
        color: '#07070c',
        fontWeight: 800,
        fontSize: isMobile ? '1.2rem' : '1rem',
        border: 'none',
        cursor: 'pointer',
        transition: 'all 180ms ease',
        boxShadow: isHeating
          ? '0 0 32px rgba(251,146,60,0.5)'
          : 'var(--shadow-glow)',
        userSelect: 'none',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      {isHeating ? '⏹ Stop Heat' : '▶ Start Heat'}
    </button>
  )
}
