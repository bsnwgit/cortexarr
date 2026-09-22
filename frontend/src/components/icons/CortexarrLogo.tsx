// Cortexarr's mark — "Pulse Ring": an open ring (nods at the "C") with a
// heartbeat crossing it, in the app's own violet/teal. Chosen 2026-09-22
// from a set of concepts; keep this component and frontend/public/favicon.svg
// in sync if either changes.
export default function CortexarrLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 120 120" className={className} xmlns="http://www.w3.org/2000/svg">
      <path
        d="M 96.7 39.3 A 42 42 0 1 1 60 18"
        fill="none"
        stroke="#8b5cf6"
        strokeWidth="10"
        strokeLinecap="round"
      />
      <polyline
        points="34,62 48,62 54,46 64,78 71,62 86,62"
        fill="none"
        stroke="#5eead4"
        strokeWidth="4.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
