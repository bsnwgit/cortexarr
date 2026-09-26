import clsx from 'clsx'
import type { ServiceAccent } from '../utils/serviceAccent'

// Shared by every "Monitored" column/field that's a live toggle (series,
// season, episode) rather than static text — one PATCH-backed pill.
//
// Two variants:
//  - "yesno" (default): text is Yes/No, styled with the page's per-service
//    accent when on — used inside a table column already headed
//    "Monitored", where the state alone needs no extra label (episode
//    rows, the Missing tab).
//  - "label": text is always "Monitor", colored red (off) or green (on) —
//    used where the pill stands alone with no adjacent column header
//    (the series and season headers), so it has to read as self-explanatory
//    on its own.
export default function MonitoredToggle({
  monitored, busy, accent, onClick, variant = 'yesno',
}: {
  monitored: boolean
  busy: boolean
  accent: ServiceAccent
  onClick: () => void
  variant?: 'yesno' | 'label'
}) {
  const isLabel = variant === 'label'
  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      disabled={busy}
      className={clsx(
        'text-xs px-2 py-1 rounded-lg border transition-colors disabled:opacity-50',
        isLabel
          ? monitored
            ? 'bg-green-600/20 text-green-300 border-green-600/40'
            : 'bg-red-600/20 text-red-300 border-red-600/40'
          : monitored
            ? clsx(accent.bg, accent.text, accent.border)
            : 'border-slate-700 text-slate-400 hover:text-slate-200 hover:bg-slate-900',
      )}
    >
      {busy ? '…' : isLabel ? 'Monitor' : monitored ? 'Yes' : 'No'}
    </button>
  )
}
