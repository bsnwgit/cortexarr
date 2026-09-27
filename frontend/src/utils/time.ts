// The time zone every date in the app is shown in — the admin's Settings >
// Time zone, loaded once by Layout. Unset means each viewer's own browser
// zone, which is what toLocale* does with no timeZone option.
let zone: string | undefined

export function isValidTimeZone(name: string) {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: name })
    return true
  } catch {
    return false
  }
}

export function setTimeZone(name: string | null | undefined) {
  zone = name && isValidTimeZone(name) ? name : undefined
}

export function getTimeZone() {
  return zone
}

export function fmtDateTime(d: Date) {
  return d.toLocaleString(undefined, { timeZone: zone })
}

export function fmtDateOnly(d: Date) {
  return d.toLocaleDateString(undefined, { timeZone: zone })
}

// Year / month (0-based) / day of a moment in the configured zone — for
// putting calendar entries and "today" on the right day.
export function zonedDay(d: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(d)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  return { year: get('year'), month: get('month') - 1, day: get('day') }
}

// Every IANA zone the browser knows, for the Settings picker.
export function allTimeZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
  return intl.supportedValuesOf ? intl.supportedValuesOf('timeZone') : []
}
