// Shared between Alerts.tsx (current problems) and Rules.tsx (alert
// rules) — both need to label the same set of events the same way.
export type Event =
  | 'unreachable'
  | 'error'
  | 'warning'
  | 'stuck'
  | 'download_failed'
  | 'request_issue'
  | 'stalled_approval'
  | 'stalled_sending'
  | 'stalled_searching'
  | 'stalled_downloading'
  | 'stalled_importing'

// Which events a service type can produce — used to narrow the service list
// once an event is picked, so a rule can't be aimed at something that never fires.
export const EVENTS: { key: Event; label: string; hint: string; types: string[] | null; state: boolean }[] = [
  { key: 'unreachable', label: 'Service unreachable', hint: "Can't connect, or the key/login is rejected.", types: null, state: true },
  { key: 'error', label: 'Service reports an error', hint: "The service's own health check says error.", types: null, state: true },
  { key: 'warning', label: 'Service reports a warning', hint: "The service's own health check says warning.", types: null, state: true },
  { key: 'stuck', label: 'Queue item stuck', hint: 'A Sonarr/Radarr download or import in warning or failed.', types: ['sonarr', 'radarr'], state: true },
  { key: 'download_failed', label: 'Download failed', hint: 'A failed download in NZBGet/SABnzbd.', types: ['nzbget', 'sabnzbd'], state: false },
  { key: 'request_issue', label: 'Request failed or issue reported', hint: 'A failed request or reported issue in Seerr.', types: ['seerr'], state: false },
  { key: 'stalled_approval', label: 'Request waiting for approval', hint: 'A Seerr request nobody has approved or declined yet.', types: ['seerr'], state: true },
  { key: 'stalled_sending', label: 'Request not in Sonarr/Radarr', hint: "Approved in Seerr but it hasn't reached Sonarr/Radarr.", types: ['seerr'], state: true },
  { key: 'stalled_searching', label: 'Request still searching', hint: 'In Sonarr/Radarr with nothing found to download yet.', types: ['seerr'], state: true },
  { key: 'stalled_downloading', label: 'Request still downloading', hint: 'Downloading for longer than this.', types: ['seerr'], state: true },
  { key: 'stalled_importing', label: 'Request stuck importing', hint: "Downloaded but not imported.", types: ['seerr'], state: true },
]
export const EVENT_LABEL = Object.fromEntries(EVENTS.map((e) => [e.key, e.label])) as Record<Event, string>
