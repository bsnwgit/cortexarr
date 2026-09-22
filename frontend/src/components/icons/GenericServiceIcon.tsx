// Placeholder shown for a service type that hasn't got its own icon in
// ServiceIcon.tsx yet — a plain neutral mark, not a stand-in brand.
export default function GenericServiceIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="10" className="fill-slate-800" />
      <circle cx="12" cy="12" r="4" className="fill-slate-500" />
    </svg>
  )
}
