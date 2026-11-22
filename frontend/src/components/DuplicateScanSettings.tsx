import { useState } from 'react'
import clsx from 'clsx'
import { api, ApiError } from '../api/client'

export interface DuplicateScanConfig {
  enabled?: boolean
  interval_minutes?: number
}

// One Sonarr or Radarr service's duplicate-file scan. It reads everything from
// the service itself — nothing to log in to or map. Sonarr looks for the same
// episode (S##E##) in two files, Radarr for a movie folder with two video
// files. Opens under the service's row in Settings → Services.
export default function DuplicateScanSettings({
  serviceId, type, config, onSaved,
}: { serviceId: number; type: string; config?: DuplicateScanConfig; onSaved: () => void }) {
  const [enabled, setEnabled] = useState(!!config?.enabled)
  const [minutes, setMinutes] = useState(config?.interval_minutes ?? 360)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  async function save() {
    setBusy(true)
    setResult(null)
    try {
      await api.patch(`/services/${serviceId}`, { duplicate_scan: { enabled, interval_minutes: minutes } })
      setResult({ ok: true, message: enabled ? 'Saved — the first scan has started.' : 'Saved — scanning is off.' })
      onSaved()
    } catch (err) {
      setResult({ ok: false, message: err instanceof ApiError ? err.message : 'Could not save' })
    } finally {
      setBusy(false)
    }
  }

  const what = type === 'radarr' ? 'a movie folder with more than one video file' : 'the same episode (S##E##) in more than one file'

  return (
    <div className="mt-3 bg-slate-950 border border-slate-800 rounded-lg p-3 space-y-3" onClick={(e) => e.stopPropagation()}>
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-0.5 accent-violet-500" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span className="text-sm text-slate-300">
          Look for duplicate files
          <span className="block text-xs text-slate-400">
            Asks this service for every folder in its library and flags {what}. Anything found shows on the
            Dashboard and the Duplicates tab, and can alert.
          </span>
        </span>
      </label>

      {enabled && (
        <label className="block max-w-xs">
          <span className="block text-sm text-slate-400 mb-1">Scan every (minutes)</span>
          <input className="input" type="number" min={10} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />
        </label>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button onClick={save} disabled={busy} className="rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-medium px-4 py-1.5">
          {busy ? 'Saving…' : 'Save'}
        </button>
        {result && <span className={clsx('text-xs', result.ok ? 'text-teal-300' : 'text-red-300')}>{result.ok ? '✓ ' : '✗ '}{result.message}</span>}
      </div>
    </div>
  )
}
