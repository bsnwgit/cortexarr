import logoUrl from './sabnzbd.svg'

// SABnzbd's own mark (github.com/sabnzbd/sabnzbd, icons/logo-arrow.svg),
// shipped unmodified as a file, same as the NZBGet icon.
export default function SabnzbdIcon({ className }: { className?: string }) {
  return <img src={logoUrl} alt="" className={className} />
}
