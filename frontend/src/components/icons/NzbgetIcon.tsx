import logoUrl from './nzbget.svg'

// NZBGet's own mark (github.com/nzbgetcom/nzbget, webui/img/nzbget.svg),
// shipped unmodified as a file — it's a layered gradient logo, so it's
// referenced as an image rather than hand-converted to JSX.
export default function NzbgetIcon({ className }: { className?: string }) {
  return <img src={logoUrl} alt="" className={className} />
}
