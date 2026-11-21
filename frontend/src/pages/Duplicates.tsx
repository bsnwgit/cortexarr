import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import clsx from 'clsx'
import { api, ApiError } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import PageSpinner from '../components/PageSpinner'
import ServiceIcon from '../components/ServiceIcon'
import { SpinnerIcon, TrashIcon } from '../components/icons/UiIcons'
import { getServiceAccent } from '../utils/serviceAccent'
import { fmtDateTime } from '../utils/time'
import { useDuplicates, type DuplicateFinding } from '../utils/useDuplicates'

// SQLite datetimes are UTC without a zone marker.
const when = (v: string) => fmtDateTime(new Date(v.replace(' ', 'T') + 'Z'))
const fileName = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const folderOf = (p: string) => p.slice(0, p.lastIndexOf('/') + 1)

// Where in Cortexarr the duplicate's own series / movie page is.
function targetPath(f: DuplicateFinding): { href: string; label: string } {
  const app = f.service_type === 'radarr' ? 'Radarr' : 'Sonarr'
  if (f.target_id == null) return { href: `/services/${f.service_id}`, label: `Open ${f.service_name}` }
  return {
    href: f.service_type === 'radarr'
      ? `/services/${f.service_id}/movies/${f.target_id}`
      : `/services/${f.service_id}/series/${f.target_id}`,
    label: `Open in ${app}`,
  }
}

// Every duplicate each Sonarr/Radarr scan has found. The top-nav tab for this
// page only exists while there is at least one.
export default function Duplicates() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [params, setParams] = useSearchParams()
  const { data, loaded, reload } = useDuplicates(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const filter = Number(params.get('service')) || null
  const shown = data.findings.filter((f) => !filter || f.service_id === filter)

  async function scan(id: number) {
    setBusy(`scan:${id}`)
    setError('')
    try {
      await api.post(`/duplicates/${id}/scan`, {})
      await reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the scan')
    } finally {
      setBusy('')
    }
  }

  async function remove(f: DuplicateFinding, path: string) {
    if (!confirm(`Delete this file from the machine that holds it? This can't be undone.\n\n${path}`)) return
    setBusy(`del:${path}`)
    setError('')
    try {
      await api.post(`/duplicates/${f.service_id}/delete`, { key: f.key, path })
      await reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete the file')
    } finally {
      setBusy('')
    }
  }

  if (!loaded) return <PageSpinner />

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <h2 className="text-lg font-semibold text-slate-100">Duplicate files</h2>
        {data.services.length > 1 && (
          <select
            value={filter ?? ''}
            onChange={(e) => setParams(e.target.value ? { service: e.target.value } : {})}
            aria-label="Show"
            className="rounded-lg bg-slate-950 border border-slate-800 px-2 py-1.5 text-sm text-slate-100"
          >
            <option value="">All services ({data.findings.length})</option>
            {data.services.map((s) => (
              <option key={s.id} value={s.id}>{s.name} ({data.counts[s.id] ?? 0})</option>
            ))}
          </select>
        )}
      </div>

      <div className="mb-4 space-y-1">
        {data.services.filter((s) => !filter || s.id === filter).map((s) => (
          <div key={s.id} className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span>
              {s.name}:{' '}
              {s.scanning
                ? 'scanning…'
                : s.scanned_at
                  ? `${s.files_seen?.toLocaleString() ?? 0} files checked ${when(s.scanned_at)}`
                  : 'not scanned yet'}
            </span>
            {isAdmin && (
              <button
                onClick={() => scan(s.id)}
                disabled={s.scanning || busy === `scan:${s.id}` || !s.enabled || s.maintenance_mode}
                className="btn-secondary !py-0.5 !px-2 !text-xs inline-flex items-center gap-1"
              >
                {s.scanning && <SpinnerIcon className="w-3 h-3 animate-spin" />}
                Scan now
              </button>
            )}
            {s.error && <span className="text-amber-300">Last scan problem: {s.error}</span>}
          </div>
        ))}
      </div>

      {error && <div className="mb-3 text-sm text-red-300 bg-red-950/50 border border-red-900 rounded-lg px-3 py-2">{error}</div>}

      {shown.length === 0 ? (
        <p className="text-sm text-slate-400">No duplicate files found.</p>
      ) : (
        <ul className="space-y-2">
          {shown.map((f) => {
            const accent = getServiceAccent(f.service_type)
            const open = targetPath(f)
            return (
              <li key={`${f.service_id}-${f.key}`} className="bg-slate-925 border border-slate-800 rounded-xl p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                    <span className="font-medium text-slate-100">{f.title}</span>
                    <span className={clsx('inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg border', accent.bg, accent.text, accent.border)}>
                      <ServiceIcon type={f.service_type} className="w-3.5 h-3.5 rounded-sm shrink-0" />
                      {f.service_name}
                    </span>
                  </div>
                  <button onClick={() => navigate(open.href)} className="btn-secondary">
                    {open.label}
                  </button>
                </div>
                <p className="mt-1 text-xs text-slate-400">
                  {f.kind === 'movie' ? 'Movie' : 'Series'} · {f.reason} · first seen {when(f.first_seen)}
                </p>
                <ul className="mt-3 space-y-1.5">
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
                  <p className="mt-3 text-xs text-slate-400">
                    This file isn't known to be a copy of anything, so it can't be deleted from here — rename it to
                    include S##E## (like S03E02) and it stops being flagged.
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
