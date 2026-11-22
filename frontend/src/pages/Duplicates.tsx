import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import clsx from 'clsx'
import { api, ApiError } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import PageSpinner from '../components/PageSpinner'
import ServiceIcon from '../components/ServiceIcon'
import { SpinnerIcon, TrashIcon } from '../components/icons/UiIcons'
import { getServiceAccent } from '../utils/serviceAccent'
import { fmtBytes } from '../utils/downloadFormat'
import { fmtDateTime } from '../utils/time'
import { useDuplicates, type DuplicateFinding } from '../utils/useDuplicates'

// SQLite datetimes are UTC without a zone marker.
const when = (v: string) => fmtDateTime(new Date(v.replace(' ', 'T') + 'Z'))
const fileName = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const folderOf = (p: string) => p.slice(0, p.lastIndexOf('/') + 1)
const leaf = (p: string) => p.replace(/\/$/, '').slice(p.replace(/\/$/, '').lastIndexOf('/') + 1)

// What each duplicate keeps: the files the user ticked, else the newest. Mirrors the server.
function keepsOf(f: DuplicateFinding, selected: Set<string>): string[] {
  const mine = f.files.filter((p) => selected.has(p))
  return mine.length ? mine : f.keep ? [f.keep] : []
}

// The extra copies "delete all" would remove: every file a duplicate doesn't keep,
// except a file another duplicate keeps (a double episode).
function extrasOf(findings: DuplicateFinding[], selected: Set<string>): string[] {
  const kept = new Set(findings.flatMap((f) => keepsOf(f, selected)))
  const out: string[] = []
  for (const f of findings) {
    if (!keepsOf(f, selected).length) continue
    for (const p of f.files) if (!kept.has(p) && !out.includes(p)) out.push(p)
  }
  return out
}

function sizeOfFiles(findings: DuplicateFinding[], paths: string[]): number {
  const sizes = new Map<string, number>()
  for (const f of findings) for (const [p, i] of Object.entries(f.info)) sizes.set(p, i.size ?? 0)
  return paths.reduce((n, p) => n + (sizes.get(p) ?? 0), 0)
}

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

// Every duplicate each Sonarr/Radarr scan has found, grouped by the series or
// movie folder they are in. The top-nav tab for this page only exists while
// there is at least one.
export default function Duplicates() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [params, setParams] = useSearchParams()
  const { data, loaded, reload } = useDuplicates(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  // Files the user ticked to keep. In a duplicate where any is ticked, only those are kept.
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const toggle = (p: string) => setSelected((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n })

  const filter = Number(params.get('service')) || null
  const shown = data.findings.filter((f) => !filter || f.service_id === filter)

  // Folder groups, in the order the findings come (they are sorted by title).
  const groups: { key: string; serviceId: number; folder: string; findings: DuplicateFinding[] }[] = []
  for (const f of shown) {
    const key = `${f.service_id}|${f.folder || f.key}`
    let g = groups.find((x) => x.key === key)
    if (!g) groups.push((g = { key, serviceId: f.service_id, folder: f.folder, findings: [] }))
    g.findings.push(f)
  }

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
    if (!confirm(`Delete this file? This can't be undone.\n\n${path}`)) return
    setBusy(`del:${path}`)
    setError('')
    setNotice('')
    try {
      await api.post(`/duplicates/${f.service_id}/delete`, { key: f.key, path })
      await reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete the file')
    } finally {
      setBusy('')
    }
  }

  // folder === null: every duplicate of the service.
  async function removeExtras(
    serviceId: number, folder: string | null, findings: DuplicateFinding[], label: string, key: string | null = null,
  ) {
    const extras = extrasOf(findings, selected)
    const skipped = findings.filter((f) => !keepsOf(f, selected).length).length
    const chosen = findings.filter((f) => f.files.some((p) => selected.has(p))).length
    if (!extras.length) return
    const msg = `Delete ${extras.length} extra file${extras.length === 1 ? '' : 's'} (${fmtBytes(sizeOfFiles(findings, extras))}) ` +
      `${label}?\n\n` +
      (chosen ? `Where you ticked Keep, only the files you ticked are kept (${chosen} duplicate${chosen === 1 ? '' : 's'}). ` : '') +
      `${chosen < findings.length ? 'In the rest, the newest file is kept. ' : ''}This can't be undone.` +
      (skipped ? `\n\n${skipped} duplicate${skipped === 1 ? '' : 's'} can't be judged (no size or date) and will be left alone.` : '')
    if (!confirm(msg)) return
    setBusy(`extras:${serviceId}:${folder ?? ''}${key ?? ''}`)
    setError('')
    setNotice('')
    try {
      const r = await api.post<{ deleted: number; skipped_count?: number; skipped?: { path: string; reason: string }[] }>(
        `/duplicates/${serviceId}/delete-extras`, { folder, key, keep: [...selected] })
      setNotice(`Deleted ${r.deleted} file${r.deleted === 1 ? '' : 's'}.` +
        (r.skipped_count ? ` ${r.skipped_count} could not be deleted (${r.skipped?.[0]?.reason ?? 'see the service'}).` : ''))
      await reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete the extra copies')
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

      <div className="mb-4 space-y-2">
        {data.services.filter((s) => !filter || s.id === filter).map((s) => {
          const mine = data.findings.filter((f) => f.service_id === s.id)
          const extras = extrasOf(mine, selected)
          return (
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
              {isAdmin && extras.length > 0 && (
                <button
                  onClick={() => removeExtras(s.id, null, mine, `across all of ${s.name}`)}
                  disabled={busy !== ''}
                  className="rounded-lg border border-red-900 text-red-300 hover:bg-red-950/50 px-2 py-0.5 inline-flex items-center gap-1"
                >
                  {busy === `extras:${s.id}:` ? <SpinnerIcon className="w-3 h-3 animate-spin" /> : <TrashIcon className="w-3 h-3" />}
                  Delete all duplicates in {s.name} ({extras.length})
                </button>
              )}
              {s.error && <span className="text-amber-300">Last scan problem: {s.error}</span>}
            </div>
          )
        })}
      </div>

      {error && <div className="mb-3 text-sm text-red-300 bg-red-950/50 border border-red-900 rounded-lg px-3 py-2">{error}</div>}
      {notice && <div className="mb-3 text-sm text-teal-300 bg-teal-950/40 border border-teal-900 rounded-lg px-3 py-2">{notice}</div>}

      {groups.length === 0 ? (
        <p className="text-sm text-slate-400">No duplicate files found.</p>
      ) : (
        <ul className="space-y-3">
          {groups.map((g) => {
            const first = g.findings[0]
            const accent = getServiceAccent(first.service_type)
            const open = targetPath(first)
            const extras = extrasOf(g.findings, selected)
            const folderBusy = busy === `extras:${g.serviceId}:${g.folder}`
            return (
              <li key={g.key} className="bg-slate-925 border border-slate-800 rounded-xl p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                    <span className="font-medium text-slate-100">{g.folder ? leaf(g.folder) : first.title}</span>
                    <span className={clsx('inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg border', accent.bg, accent.text, accent.border)}>
                      <ServiceIcon type={first.service_type} className="w-3.5 h-3.5 rounded-sm shrink-0" />
                      {first.service_name}
                    </span>
                    <span className="text-xs text-slate-400">
                      {g.findings.length} duplicate{g.findings.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {isAdmin && g.findings.length > 1 && extras.length > 0 && (
                      <button
                        onClick={() => removeExtras(g.serviceId, g.folder, g.findings, `in ${leaf(g.folder)}`)}
                        disabled={busy !== ''}
                        className="rounded-lg border border-red-900 text-red-300 hover:bg-red-950/50 px-2 py-1 text-xs inline-flex items-center gap-1"
                      >
                        {folderBusy ? <SpinnerIcon className="w-3.5 h-3.5 animate-spin" /> : <TrashIcon className="w-3.5 h-3.5" />}
                        Delete all duplicates in this folder ({extras.length})
                      </button>
                    )}
                    <button onClick={() => navigate(open.href)} className="btn-secondary">
                      {open.label}
                    </button>
                  </div>
                </div>

                <ul className="mt-3 space-y-3">
                  {g.findings.map((f) => (
                    <li key={f.key}>
                      <p className="text-xs text-slate-400">
                        {f.kind === 'movie' ? 'Movie' : f.title.includes(' — ') ? f.title.slice(f.title.indexOf(' — ') + 3) : 'Series'}
                        {' · '}{f.reason} · first seen {when(f.first_seen)}
                      </p>
                      {isAdmin && f.files.some((p) => selected.has(p)) && f.files.some((p) => !selected.has(p)) && (
                        <button
                          onClick={() => removeExtras(f.service_id, null, [f], 'in this duplicate', f.key)}
                          disabled={busy !== ''}
                          className="mt-1.5 rounded-lg border border-red-900 text-red-300 hover:bg-red-950/50 px-2 py-0.5 text-xs inline-flex items-center gap-1"
                        >
                          <TrashIcon className="w-3 h-3" />
                          Delete the others, keep what I ticked
                        </button>
                      )}
                      <ul className="mt-1.5 space-y-1.5">
                        {f.files.map((p) => {
                          const i = f.info[p]
                          return (
                            <li key={p} className="flex items-start gap-2 text-xs">
                              <span className="flex-1 min-w-0 break-all text-slate-400">
                                {folderOf(p)}
                                <span className="text-slate-100">{fileName(p)}</span>
                                {i && (
                                  <span className="block text-slate-400">
                                    {i.size != null ? fmtBytes(i.size) : 'size unknown'}
                                    {i.modified ? ` · changed ${fmtDateTime(new Date(i.modified))}` : ''}
                                  </span>
                                )}
                              </span>
                              {!f.files.some((x) => selected.has(x)) && f.keep === p && (
                                <span className="shrink-0 rounded-lg border border-teal-900 bg-teal-950/40 text-teal-300 px-2 py-1">
                                  Keep (newest)
                                </span>
                              )}
                              {isAdmin && f.deletable && (
                                <label className="shrink-0 inline-flex items-center gap-1 text-slate-300 px-1 py-1 cursor-pointer">
                                  <input type="checkbox" className="accent-teal-500" checked={selected.has(p)} onChange={() => toggle(p)} />
                                  Keep
                                </label>
                              )}
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
                          )
                        })}
                      </ul>
                      {!f.deletable && (
                        <p className="mt-1.5 text-xs text-slate-400">
                          This file isn't known to be a copy of anything, so it can't be deleted from here — rename it to
                          include S##E## (like S03E02) and it stops being flagged.
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
