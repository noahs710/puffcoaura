// ============================================================
// TempRing — SVG temperature ring (desktop) / large display (mobile)
// ============================================================
import { useIsMobileLayout } from '../ui/useIsMobileLayout'

interface Props {
  current: number
  target: number
  isHeating: boolean
  unit: 'F' | 'C'
}

export function TempRing({ current, target, isHeating, unit }: Props) {
  const isMobile = useIsMobileLayout()
  const pct = Math.min(100, Math.max(0, ((current - 200) / 400) * 100))

  const r = 90
  const circ = 2 * Math.PI * r
  const dashOffset = circ * (1 - pct / 100)

  const color = isHeating ? 'var(--accent-orange)' : 'var(--accent)'

  return (
    <div className={`temp-ring-container ${isMobile ? 'mobile' : 'desktop'}`}>
      <svg viewBox="0 0 220 220" className="temp-ring-svg" aria-label={`Temperature ${current}°${unit}`}>
        {/* Track */}
        <circle
          cx="110" cy="110" r={r}
          fill="none"
          stroke="var(--border-subtle)"
          strokeWidth="12"
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={0}
        />
        {/* Progress */}
        <circle
          cx="110" cy="110" r={r}
          fill="none"
          stroke={color}
          strokeWidth="12"
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={dashOffset}
          style={{
            transition: 'stroke-dashoffset 800ms ease, stroke 400ms',
            filter: isHeating ? `drop-shadow(0 0 8px ${color})` : 'none',
          }}
          transform="rotate(-90 110 110)"
        />
        {/* Text */}
        <text x="110" y="100" textAnchor="middle" dominantBaseline="middle" className="temp-current-text">
          {Math.round(current)}
        </text>
        <text x="110" y="130" textAnchor="middle" dominantBaseline="middle" className="temp-unit-text">
          °{unit}
        </text>
        {isHeating && (
          <text x="110" y="155" textAnchor="middle" dominantBaseline="middle" className="temp-status-text">
            Heating…
          </text>
        )}
      </svg>
      <div className="temp-target-label">Target: {target}°{unit}</div>
    </div>
  )
}
