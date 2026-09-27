import { SpinnerIcon } from './icons/UiIcons'

// The one loading state for every page and panel: a swirling icon centred
// in the space the content will fill, instead of plain "Loading…" text —
// most noticeable on Tracking, whose first load can take a few seconds
// while it reads every service.
export default function PageSpinner({ className = 'py-16' }: { className?: string }) {
  return (
    <div className={`flex items-center justify-center ${className}`}>
      <SpinnerIcon className="w-7 h-7 text-violet-400 animate-spin" />
    </div>
  )
}
