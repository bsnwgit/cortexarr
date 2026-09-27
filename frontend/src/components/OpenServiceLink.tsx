import { ExternalLinkIcon } from './icons/UiIcons'

// A small icon in a dashboard card's header that opens the service's own
// web UI in a new tab — the card only summarises, this is one click into
// the real app. Only http(s) URLs render, so a stored URL can never become
// a script link; the click stops at the icon so the card underneath
// doesn't also navigate.
export default function OpenServiceLink({ url, name }: { url?: string; name: string }) {
  if (!url || !/^https?:\/\//i.test(url)) return null
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={`Open ${name}`}
      aria-label={`Open ${name}`}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      className="p-1 rounded-md text-slate-300 hover:text-slate-100 hover:bg-slate-900/70 transition-colors"
    >
      <ExternalLinkIcon className="w-4 h-4" />
    </a>
  )
}
