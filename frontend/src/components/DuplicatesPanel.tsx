import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import { SpinnerIcon, TrashIcon } from './icons/UiIcons'
import { fmtDateTime } from '../utils/time'

interface Library {
  id: number
  name: string
  enabled: boolean
  maintenance_mode: boolean
  scanned_at: string | null
  files_seen: number | null
  seconds: number | null
  health: string | null
  scanning: boolean
}

interface Finding {
  service_id: number
  service_name: string
  key: string
  kind: 'movie' | 'series'
  title: string
  reason: string
  files: string[]
  deletable: boolean
  first_seen: string
}

// SQLite datetimes are UTC without a zone marker.
const when = (v: string) => fmtDateTime(new Date(v.replace(' ', 'T') + 'Z'))
const fileName = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const folderOf = (p: string) => p.slice(0, p.lastIndexOf('/') + 1)

// Duplicate movie and episode files found by scanning a library over SSH
// (a "library" service). Shows on the Dashboard and on Tracking; hides itself
// when no library is set up, so it costs nothing until it is.
export default function DuplicatesPanel() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [libraries, setLibraries] = useState<Library[] | null>(null)
  const [findings, setFindings] = useState<Finding[]>([])
  const [busy, setBusy] = useState<string>('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ libraries: Library[]; findings: Finding[] }>('/duplicates/')
      setLibraries(data.libraries)
      setFindings(data.findings)
    } catch {
      setLibraries((l) => l ?? [])
    }
  }, [])

  const scanning = libraries?.some((l) => l.scanning) ?? false
  useEffect(() => {
    load()
    // A scan can take minutes: look more often while one runs.
    const interval = setInterval(load, scanning ? 4000 : 30000)
    return () => clearInterval(interval)
  }, [load, scanning])

  async function scan(l: Library) {
    setBusy(`scan:${l.id}`)
    setError('')
    try {
      await api.post(`/duplicates/${l.id}/scan`, {})
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the scan')
    } finally {
      setBusy('')
    }
  }

  async function remove(f: Finding, path: string) {
    if (!confirm(`Delete this file from the library machine? This can't be undone.\n\n${path}`)) return
    setBusy(`del:${path}`)
    setError('')
    try {
      await api.post(`/duplicates/${f.service_id}/delete`, { key: f.key, path })
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete the file')
    } finally {
      setBusy('')
    }
  }

  if (!libraries || libraries.length === 0) return null

  return (
    <section className="bg-slate-925 border border-slate-800 rounded-xl p-4 mb-4" aria-label="Duplicate files">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="font-medium text-slate-100">Duplicate files</h3>
          <span
            className={
              findings.length
                ? 'rounded-full bg-amber-500/15 text-amber-300 text-xs px-2 py-0.5'
                : 'rounded-full bg-teal-600/20 text-teal-300 text-xs px-2 py-0.5'
            }
          >
            {findings.length ? `${findings.length} found` : 'none found'}
          </span>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 items-center">
          {libraries.map((l) => (
            <span key={l.id} className="flex items-center gap-2 text-xs text-slate-400">
              {l.name}:{' '}
              {l.scanning
                ? 'scanning…'
                : l.scanned_at
                  ? `${l.files_seen?.toLocaleString()} files, ${when(l.scanned_at)}`
                  : 'not scanned yet'}
              {l.health && l.health !== 'ok' && <span className="text-amber-300">({l.health})</span>}
              {isAdmin && (
                <button
                  onClick={() => scan(l)}
                  disabled={l.scanning || busy === `scan:${l.id}` || !l.enabled || l.maintenance_mode}
                  className="btn-secondary !py-0.5 !px-2 !text-xs inline-flex items-center gap-1"
                >
                  {l.scanning && <SpinnerIcon className="w-3 h-3 animate-spin" />}
                  Scan now
                </button>
              )}
            </span>
          ))}
        </div>
      </div>

      {error && <div className="mt-3 text-sm text-red-300 bg-red-950/50 border border-red-900 rounded-lg px-3 py-2">{error}</div>}

      {findings.length > 0 && (
        <ul className="mt-3 space-y-2">
          {findings.map((f) => (
            <li key={`${f.service_id}-${f.key}`} className="bg-slate-950 border border-slate-800 rounded-lg p-3">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-slate-100 font-medium">{f.title}</span>
                <span className="text-xs text-slate-400">
                  {f.kind === 'movie' ? 'Movie' : 'Series'} · {f.reason} · {f.service_name}
                </span>
              </div>
              <ul className="mt-2 space-y-1">
                {f.files.map((p) => (
                  <li key={p} className="flex items-start gap-2 text-xs">
                    <span className="flex-1 min-w-0 break-all text-slate-400">
                      {folderOf(p)}
                      <span className="text-slate-100">{fileName(p)}</span>
                    </span>
                    {isAdmin && f.deletable && (
                      <button
                        onClick={() => remove(f, p)}
                        disabled={busy === `del:${p}`}
                        title="Delete this copy"
                        aria-label={`Delete ${fileName(p)}`}
                        className="shrink-0 rounded-lg border border-red-900 text-red-300 hover:bg-red-950/50 px-2 py-1 inline-flex items-center gap-1"
                      >
                        {busy === `del:${p}` ? <SpinnerIcon className="w-3.5 h-3.5 animate-spin" /> : <TrashIcon className="w-3.5 h-3.5" />}
                        Delete
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {!f.deletable && (
                <p className="mt-2 text-xs text-slate-400">
                  Not known to be a copy of anything, so it can't be deleted from here — rename it to include S##E##
                  (like S03E02) and it stops being flagged.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
