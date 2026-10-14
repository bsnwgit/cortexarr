import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { api, ApiError } from '../api/client'
import { PageControls } from './Pagination'
import PageSpinner from './PageSpinner'
import ConfirmDeleteModal from './ConfirmDeleteModal'
import { RefreshIcon, SpinnerIcon, TrashIcon } from './icons/UiIcons'
import type { ServiceAccent } from '../utils/serviceAccent'

// The Live TV page's four panels. Each one talks to /api/livetv/{id}/…,
// which proxies Dispatcharr with the credentials saved in Settings → Services.
// `canAct` = analyst or admin (refresh, enable, edit, stop); `isAdmin` =
// account/source changes, which carry provider credentials.

export interface PanelProps {
  serviceId: number
  accent: ServiceAccent
  canAct: boolean
  isAdmin: boolean
}

const errMsg = (e: unknown, fallback: string) => (e instanceof ApiError || e instanceof Error ? e.message : fallback)

function Notice({ error, ok }: { error?: string; ok?: string }) {
  if (error) return <p className="text-sm text-red-300 bg-red-950/50 border border-red-900 rounded-lg px-3 py-2 mb-3">{error}</p>
  if (ok) return <p className="text-sm text-emerald-300 bg-emerald-950/40 border border-emerald-900 rounded-lg px-3 py-2 mb-3">{ok}</p>
  return null
}

function StatusPill({ status }: { status?: string }) {
  const s = status || 'idle'
  const tone =
    s === 'success' ? 'text-emerald-300 border-emerald-700/60'
    : s === 'error' ? 'text-red-300 border-red-800'
    : s === 'fetching' || s === 'parsing' ? 'text-sky-300 border-sky-700/60'
    : 'text-slate-400 border-slate-700'
  return <span className={clsx('inline-block rounded-lg border px-2 py-0.5 text-xs', tone)}>{s.replace('_', ' ')}</span>
}

function ActionButton({ children, busy, onClick, disabled, danger, title }: {
  children: ReactNode; busy?: boolean; onClick: () => void; disabled?: boolean; danger?: boolean; title?: string
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={busy || disabled}
      onClick={onClick}
      className={clsx(
        'rounded-lg border text-xs px-2.5 py-1 disabled:opacity-50 inline-flex items-center gap-1.5',
        danger ? 'border-red-900 text-red-300 hover:bg-red-950/50' : 'border-slate-700 text-slate-200 hover:bg-slate-900',
      )}
    >
      {busy && <SpinnerIcon className="w-3.5 h-3.5 animate-spin" />}
      {children}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Generic add/edit form — a field list, so M3U accounts and EPG sources share it
// ---------------------------------------------------------------------------

interface FieldDef {
  key: string
  label: string
  kind?: 'text' | 'password' | 'number' | 'select' | 'bool'
  options?: { value: string; label: string }[]
  hint?: string
}

function EditModal({ title, fields, initial, busy, error, onSave, onCancel }: {
  title: string
  fields: FieldDef[]
  initial: Record<string, unknown>
  busy: boolean
  error: string
  onSave: (values: Record<string, unknown>) => void
  onCancel: () => void
}) {
  const [values, setValues] = useState<Record<string, unknown>>(initial)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto bg-slate-925 border border-slate-800 rounded-xl p-6 shadow-xl">
        <h3 className="text-base font-semibold text-slate-100 mb-4">{title}</h3>
        <Notice error={error} />
        <div className="space-y-3">
          {fields.map((f) => (
            <label key={f.key} className="block">
              {f.kind === 'bool' ? (
                <span className="flex items-center gap-2 text-sm text-slate-300">
                  <input
                    type="checkbox"
                    className="accent-sky-500"
                    checked={!!values[f.key]}
                    onChange={(e) => setValues({ ...values, [f.key]: e.target.checked })}
                  />
                  {f.label}
                </span>
              ) : (
                <>
                  <span className="block text-sm text-slate-400 mb-1">{f.label}</span>
                  {f.kind === 'select' ? (
                    <select
                      className="input"
                      value={String(values[f.key] ?? '')}
                      onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                    >
                      {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  ) : (
                    <input
                      className="input"
                      type={f.kind === 'password' ? 'password' : f.kind === 'number' ? 'number' : 'text'}
                      autoComplete={f.kind === 'password' ? 'new-password' : 'off'}
                      value={String(values[f.key] ?? '')}
                      onChange={(e) =>
                        setValues({ ...values, [f.key]: f.kind === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value })
                      }
                    />
                  )}
                </>
              )}
              {f.hint && <span className="block text-xs text-slate-400 mt-1">{f.hint}</span>}
            </label>
          ))}
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onCancel} disabled={busy} className="btn-secondary">Cancel</button>
          <button
            onClick={() => onSave(values)}
            disabled={busy}
            className="rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white text-sm font-medium px-4 py-2"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Streams — who is watching right now
// ---------------------------------------------------------------------------

interface StreamRow { [k: string]: unknown }

// Dispatcharr's status payload is undocumented, so names/ids are read from the
// first key that exists; anything unrecognised is still viewable under Details.
function pick(row: StreamRow, keys: string[]): string {
  for (const k of keys) {
    const v = row[k]
    if (v !== undefined && v !== null && v !== '') return String(v)
  }
  return ''
}

export function StreamsPanel({ serviceId, canAct, tick }: PanelProps & { tick: number }) {
  const [rows, setRows] = useState<StreamRow[] | null>(null)
  const [error, setError] = useState('')
  const [ok, setOk] = useState('')
  const [busy, setBusy] = useState('')
  const [confirm, setConfirm] = useState<{ id: string; name: string } | null>(null)

  const load = useCallback(async () => {
    try {
      const d = await api.get<{ channels: StreamRow[] }>(`/livetv/${serviceId}/streams`)
      setRows(d.channels)
      setError('')
    } catch (e) {
      setError(errMsg(e, 'Failed to load streams'))
      setRows((r) => r ?? [])
    }
  }, [serviceId])

  useEffect(() => {
    load()
    const t = setInterval(load, 10000)
    return () => clearInterval(t)
  }, [load, tick])

  async function stop() {
    if (!confirm) return
    setBusy(confirm.id)
    try {
      await api.post(`/livetv/${serviceId}/streams/${encodeURIComponent(confirm.id)}/stop`)
      setOk(`Stopped ${confirm.name}`)
      setError('')
      setConfirm(null)
      await load()
    } catch (e) {
      setError(errMsg(e, 'Could not stop the stream'))
    } finally {
      setBusy('')
    }
  }

  if (rows === null) return <PageSpinner className="py-6" />
  return (
    <div className="bg-slate-925 border border-slate-800 rounded-xl p-3 sm:p-4">
      <Notice error={error} ok={ok} />
      {rows.length === 0 ? (
        <p className="text-sm text-slate-400 py-6 text-center">Nobody is watching anything right now.</p>
      ) : (
        <ul className="divide-y divide-slate-800">
          {rows.map((r, i) => {
            const id = pick(r, ['channel_id', 'uuid', 'id'])
            const name = pick(r, ['channel_name', 'name', 'title']) || id || `Stream ${i + 1}`
            const clients = r.client_count ?? (Array.isArray(r.clients) ? r.clients.length : undefined)
            return (
              <li key={id || i} className="py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm text-slate-100 truncate">{name}</p>
                    <p className="text-xs text-slate-400">
                      {clients !== undefined ? `${clients} viewer${clients === 1 ? '' : 's'}` : 'Active'}
                      {pick(r, ['state', 'status']) && ` · ${pick(r, ['state', 'status'])}`}
                    </p>
                  </div>
                  {canAct && id && (
                    <ActionButton danger busy={busy === id} onClick={() => setConfirm({ id, name })}>Stop stream</ActionButton>
                  )}
                </div>
                <details className="mt-1">
                  <summary className="text-xs text-slate-400 cursor-pointer">Details</summary>
                  <pre className="text-xs text-slate-300 bg-slate-950 border border-slate-800 rounded-lg p-2 mt-1 overflow-x-auto">
                    {JSON.stringify(r, null, 2)}
                  </pre>
                </details>
              </li>
            )
          })}
        </ul>
      )}
      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-sm bg-slate-925 border border-slate-800 rounded-xl p-6 shadow-xl">
            <h3 className="text-base font-semibold text-slate-100 mb-2">Stop {confirm.name}?</h3>
            <p className="text-sm text-slate-300 mb-4">Everyone watching this channel is disconnected.</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirm(null)} className="btn-secondary">Cancel</button>
              <button
                onClick={stop}
                disabled={busy === confirm.id}
                className="rounded-lg bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white text-sm font-medium px-4 py-2"
              >
                Stop stream
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

interface Channel {
  id: number
  name: string
  channel_number?: number | null
  channel_group_id?: number | null
  hidden_from_output?: boolean
}
interface Group { id: number; name: string }
interface Profile { id: number; name: string; channels?: unknown }

// A channel profile's `channels` is the list of channel ids enabled in it
// (Dispatcharr's own screen reads it the same way). Anything not in the list
// is off in that profile. Null when the field isn't a list at all.
function enabledSet(profile?: Profile): Set<number> | null {
  if (!profile || !Array.isArray(profile.channels)) return null
  return new Set((profile.channels as unknown[]).filter((c): c is number => typeof c === 'number'))
}

export function ChannelsPanel({ serviceId, accent, canAct, tick }: PanelProps & { tick: number }) {
  const [channels, setChannels] = useState<Channel[] | null>(null)
  const [count, setCount] = useState(0)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [group, setGroup] = useState('')
  const [groups, setGroups] = useState<Group[]>([])
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [profileId, setProfileId] = useState<number | null>(null)
  // 'all' lists every channel (each marked on/off for the chosen profile);
  // 'enabled' lists only what's switched on in that profile.
  const [view, setView] = useState<'all' | 'enabled'>('all')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [lastIndex, setLastIndex] = useState<number | null>(null)
  const [selectingAll, setSelectingAll] = useState(false)
  const [error, setError] = useState('')
  const [ok, setOk] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<Channel | null>(null)
  const [editError, setEditError] = useState('')
  const [profileError, setProfileError] = useState('')
  const pageSize = 50

  useEffect(() => {
    api.get<Group[]>(`/livetv/${serviceId}/groups`).then(setGroups).catch(() => setGroups([]))
    api
      .get<Profile[]>(`/livetv/${serviceId}/profiles`)
      .then((p) => {
        setProfiles(p)
        setProfileId((cur) => cur ?? p[0]?.id ?? null)
        setProfileError('')
      })
      .catch((e) => {
        setProfiles([])
        setProfileError(errMsg(e, 'Could not load channel profiles'))
      })
  }, [serviceId, tick])

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) })
    if (query) params.set('search', query)
    if (group) params.set('group', group)
    if (view === 'enabled' && profileId !== null) params.set('profile', String(profileId))
    try {
      const d = await api.get<{ count: number; results: Channel[] }>(`/livetv/${serviceId}/channels?${params}`)
      setChannels(d.results)
      setCount(d.count)
      setError('')
    } catch (e) {
      setError(errMsg(e, 'Failed to load channels'))
      setChannels((c) => c ?? [])
    }
  }, [serviceId, page, query, group, view, profileId])

  useEffect(() => {
    load()
  }, [load, tick])

  const profile = profiles.find((p) => p.id === profileId)
  const enabled = useMemo(() => enabledSet(profile), [profile])
  const groupName = useMemo(() => new Map(groups.map((g) => [g.id, g.name])), [groups])
  const totalPages = Math.max(1, Math.ceil(count / pageSize))

  async function setEnabled(ids: number[], on: boolean) {
    if (profileId === null || ids.length === 0) return
    setBusy(true)
    try {
      await api.post(`/livetv/${serviceId}/channels/enable`, { profile_id: profileId, channel_ids: ids, enabled: on })
      setOk(`${on ? 'Enabled' : 'Disabled'} ${ids.length} channel${ids.length === 1 ? '' : 's'} in ${profile?.name ?? 'the profile'}`)
      setError('')
      setSelected(new Set())
      const p = await api.get<Profile[]>(`/livetv/${serviceId}/profiles`)
      setProfiles(p)
      await load() // in the enabled-only view, rows enter or leave the list
    } catch (e) {
      setError(errMsg(e, 'Could not change channels'))
    } finally {
      setBusy(false)
    }
  }

  async function saveEdit(values: Record<string, unknown>) {
    if (!editing) return
    setBusy(true)
    setEditError('')
    try {
      await api.patch(`/livetv/${serviceId}/channels/${editing.id}`, {
        name: values.name,
        channel_number: values.channel_number === '' ? null : values.channel_number,
        channel_group_id: values.channel_group_id === '' ? null : Number(values.channel_group_id),
      })
      setEditing(null)
      setOk(`Saved ${String(values.name)}`)
      await load()
    } catch (e) {
      setEditError(errMsg(e, 'Could not save'))
    } finally {
      setBusy(false)
    }
  }

  // Click toggles one; shift-click selects (or clears) everything between the
  // last click and this one on the page.
  function toggle(index: number, shift: boolean) {
    if (!channels) return
    const next = new Set(selected)
    const id = channels[index].id
    const turnOn = !next.has(id)
    if (shift && lastIndex !== null) {
      const [from, to] = [Math.min(lastIndex, index), Math.max(lastIndex, index)]
      for (const c of channels.slice(from, to + 1)) {
        if (turnOn) next.add(c.id)
        else next.delete(c.id)
      }
    } else if (turnOn) next.add(id)
    else next.delete(id)
    setSelected(next)
    setLastIndex(index)
  }

  const pageIds = channels?.map((c) => c.id) ?? []
  const pageAllSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id))
  const pageSomeSelected = pageIds.some((id) => selected.has(id))

  function togglePage() {
    const next = new Set(selected)
    for (const id of pageIds) {
      if (pageAllSelected) next.delete(id)
      else next.add(id)
    }
    setSelected(next)
  }

  async function selectAllMatching() {
    setSelectingAll(true)
    try {
      const params = new URLSearchParams()
      if (query) params.set('search', query)
      if (group) params.set('group', group)
      if (view === 'enabled' && profileId !== null) params.set('profile', String(profileId))
      const d = await api.get<{ ids: number[] }>(`/livetv/${serviceId}/channels/ids?${params}`)
      setSelected(new Set(d.ids))
      setError('')
    } catch (e) {
      setError(errMsg(e, 'Could not select all matching channels'))
    } finally {
      setSelectingAll(false)
    }
  }

  // Large bulk changes get one confirmation.
  async function bulkSet(on: boolean) {
    const ids = [...selected]
    if (ids.length > 100 && !window.confirm(`${on ? 'Enable' : 'Disable'} ${ids.length} channels in ${profile?.name ?? 'this profile'}?`)) return
    await setEnabled(ids, on)
  }

  return (
    <div className="bg-slate-925 border border-slate-800 rounded-xl p-3 sm:p-4">
      <Notice error={error} ok={ok} />
      {profileError && <Notice error={`Channel profiles didn't load: ${profileError}`} />}
      <div className="flex flex-wrap items-end gap-2 mb-3">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            setPage(1)
            setQuery(search.trim())
          }}
        >
          <input className="input w-48" placeholder="Search channels" value={search} onChange={(e) => setSearch(e.target.value)} />
          <button className="btn-secondary" type="submit">Search</button>
        </form>
        <select className="input w-44" value={group} onChange={(e) => { setPage(1); setGroup(e.target.value) }}>
          <option value="">All groups</option>
          {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        {profiles.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 ml-auto">
            <label className="flex items-center gap-2 text-sm text-slate-400">
              Profile
              <select
                className="input w-40"
                value={profileId ?? ''}
                onChange={(e) => { setPage(1); setProfileId(Number(e.target.value)) }}
              >
                {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            <select
              className="input w-56"
              value={view}
              aria-label="Which channels to list"
              onChange={(e) => { setPage(1); setView(e.target.value as 'all' | 'enabled') }}
            >
              <option value="all">All channels</option>
              <option value="enabled">
                Enabled in {profile?.name ?? 'profile'}{enabled ? ` (${enabled.size})` : ''}
              </option>
            </select>
          </div>
        )}
      </div>

      {canAct && selected.size > 0 && (
        <div className={clsx('flex items-center gap-2 rounded-lg border px-3 py-2 mb-3', accent.bg, accent.border)}>
          <span className="text-sm text-slate-100">{selected.size} selected</span>
          {pageAllSelected && count > selected.size && (
            <ActionButton busy={selectingAll} onClick={selectAllMatching}>
              Select all {count} matching
            </ActionButton>
          )}
          <ActionButton busy={busy} onClick={() => bulkSet(true)}>Enable</ActionButton>
          <ActionButton busy={busy} onClick={() => bulkSet(false)}>Disable</ActionButton>
          <button className="text-xs text-slate-400 hover:text-slate-200 ml-auto" onClick={() => setSelected(new Set())}>Deselect</button>
        </div>
      )}

      {channels === null ? (
        <PageSpinner className="py-6" />
      ) : channels.length === 0 ? (
        <p className="text-sm text-slate-400 py-6 text-center">No channels match.</p>
      ) : (
        <ul className="divide-y divide-slate-800">
          {canAct && (
            <li className="flex items-center gap-3 py-2">
              <input
                type="checkbox"
                className="accent-sky-500"
                checked={pageAllSelected}
                ref={(el) => { if (el) el.indeterminate = pageSomeSelected && !pageAllSelected }}
                onChange={togglePage}
                aria-label="Select every channel on this page"
              />
              <span className="text-xs text-slate-400">Select this page ({channels.length})</span>
              {count > channels.length && (
                <button
                  className="text-xs text-sky-300 hover:underline disabled:opacity-50"
                  disabled={selectingAll}
                  onClick={selectAllMatching}
                >
                  {query || group ? `Select all ${count} matching` : `Select all ${count}`}
                </button>
              )}
            </li>
          )}
          {channels.map((c, index) => {
            const on = enabled ? enabled.has(c.id) : undefined
            return (
              <li key={c.id} className="flex items-center gap-3 py-2">
                {canAct && (
                  <input
                    type="checkbox"
                    className="accent-sky-500"
                    checked={selected.has(c.id)}
                    onChange={() => undefined}
                    onClick={(e) => toggle(index, e.shiftKey)}
                    aria-label={`Select ${c.name}`}
                  />
                )}
                <span className="w-12 text-xs text-slate-400 tabular-nums">{c.channel_number ?? ''}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-slate-100 truncate">{c.name}</p>
                  <p className="text-xs text-slate-400 truncate">
                    {c.channel_group_id ? groupName.get(c.channel_group_id) ?? `Group ${c.channel_group_id}` : 'No group'}
                  </p>
                </div>
                {on !== undefined && (
                  <span className={clsx('text-xs', on ? 'text-emerald-300' : 'text-slate-400')}>{on ? 'Enabled' : 'Disabled'}</span>
                )}
                {canAct && (
                  <div className="flex gap-1.5 shrink-0">
                    <ActionButton busy={busy} onClick={() => setEnabled([c.id], true)} disabled={on === true}>Enable</ActionButton>
                    <ActionButton busy={busy} onClick={() => setEnabled([c.id], false)} disabled={on === false}>Disable</ActionButton>
                    <ActionButton onClick={() => { setEditError(''); setEditing(c) }}>Edit</ActionButton>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <div className="flex items-center justify-between mt-3">
        <span className="text-xs text-slate-400">{count} channel{count === 1 ? '' : 's'}</span>
        <PageControls page={page} totalPages={totalPages} onChange={setPage} />
      </div>

      {editing && (
        <EditModal
          title={`Edit ${editing.name}`}
          busy={busy}
          error={editError}
          initial={{ name: editing.name, channel_number: editing.channel_number ?? '', channel_group_id: editing.channel_group_id ?? '' }}
          fields={[
            { key: 'name', label: 'Name' },
            { key: 'channel_number', label: 'Channel number', kind: 'number' },
            {
              key: 'channel_group_id', label: 'Group', kind: 'select',
              options: [{ value: '', label: 'No group' }, ...groups.map((g) => ({ value: String(g.id), label: g.name }))],
            },
          ]}
          onSave={saveEdit}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// M3U accounts and EPG sources share one layout
// ---------------------------------------------------------------------------

interface Feed {
  id: number
  name: string
  status?: string
  last_message?: string
  is_active?: boolean
  [k: string]: unknown
}

function FeedPanel({
  serviceId, canAct, isAdmin, tick, kind, noun, fields, defaults, describe,
}: PanelProps & {
  tick: number
  kind: 'm3u' | 'epg'
  noun: string
  fields: FieldDef[]
  defaults: Record<string, unknown>
  describe: (f: Feed) => string
}) {
  const [rows, setRows] = useState<Feed[] | null>(null)
  const [error, setError] = useState('')
  const [ok, setOk] = useState('')
  const [busy, setBusy] = useState('')
  const [editing, setEditing] = useState<{ row: Feed | null } | null>(null)
  const [editError, setEditError] = useState('')
  const [deleting, setDeleting] = useState<Feed | null>(null)

  const load = useCallback(async () => {
    try {
      setRows(await api.get<Feed[]>(`/livetv/${serviceId}/${kind}`))
      setError('')
    } catch (e) {
      setError(errMsg(e, `Failed to load ${noun}s`))
      setRows((r) => r ?? [])
    }
  }, [serviceId, kind, noun])

  useEffect(() => {
    load()
  }, [load, tick])

  async function refresh(row?: Feed) {
    setBusy(row ? `r${row.id}` : 'all')
    try {
      await api.post(row ? `/livetv/${serviceId}/${kind}/${row.id}/refresh` : `/livetv/${serviceId}/${kind}/refresh`)
      setOk(row ? `Refresh started for ${row.name}` : 'Refresh started for every account')
      setError('')
      setTimeout(load, 1500)
    } catch (e) {
      setError(errMsg(e, 'Refresh failed'))
    } finally {
      setBusy('')
    }
  }

  async function save(values: Record<string, unknown>) {
    setBusy('save')
    setEditError('')
    try {
      const row = editing?.row
      if (row) await api.patch(`/livetv/${serviceId}/${kind}/${row.id}`, values)
      else await api.post(`/livetv/${serviceId}/${kind}`, values)
      setOk(row ? `Saved ${String(values.name)}` : `Added ${String(values.name)}`)
      setEditing(null)
      await load()
    } catch (e) {
      setEditError(errMsg(e, 'Could not save'))
    } finally {
      setBusy('')
    }
  }

  async function remove() {
    if (!deleting) return
    setBusy('delete')
    try {
      await api.delete(`/livetv/${serviceId}/${kind}/${deleting.id}`)
      setOk(`Deleted ${deleting.name}`)
      setDeleting(null)
      await load()
    } catch (e) {
      setError(errMsg(e, 'Could not delete'))
      setDeleting(null)
    } finally {
      setBusy('')
    }
  }

  if (rows === null) return <PageSpinner className="py-6" />
  return (
    <div className="bg-slate-925 border border-slate-800 rounded-xl p-3 sm:p-4">
      <Notice error={error} ok={ok} />
      <div className="flex justify-end gap-2 mb-3">
        {canAct && kind === 'm3u' && (
          <ActionButton busy={busy === 'all'} onClick={() => refresh()}>
            <RefreshIcon className="w-3.5 h-3.5" /> Refresh all
          </ActionButton>
        )}
        {isAdmin && (
          <ActionButton onClick={() => { setEditError(''); setEditing({ row: null }) }}>Add {noun}</ActionButton>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-400 py-6 text-center">No {noun}s yet.</p>
      ) : (
        <ul className="divide-y divide-slate-800">
          {rows.map((r) => (
            <li key={r.id} className="py-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm text-slate-100 flex items-center gap-2 flex-wrap">
                  {r.name}
                  <StatusPill status={r.is_active === false ? 'disabled' : r.status} />
                </p>
                <p className="text-xs text-slate-400 truncate">{describe(r)}</p>
                {r.last_message && r.status === 'error' && (
                  <p className="text-xs text-red-300 mt-0.5">{r.last_message}</p>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5 justify-end shrink-0">
                {canAct && (
                  <ActionButton busy={busy === `r${r.id}`} onClick={() => refresh(r)}>
                    <RefreshIcon className="w-3.5 h-3.5" /> Refresh
                  </ActionButton>
                )}
                {isAdmin && <ActionButton onClick={() => { setEditError(''); setEditing({ row: r }) }}>Edit</ActionButton>}
                {isAdmin && (
                  <ActionButton danger title={`Delete ${r.name}`} onClick={() => setDeleting(r)}>
                    <TrashIcon className="w-3.5 h-3.5" />
                  </ActionButton>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <EditModal
          title={editing.row ? `Edit ${editing.row.name}` : `Add ${noun}`}
          busy={busy === 'save'}
          error={editError}
          fields={fields}
          initial={editing.row ? Object.fromEntries(fields.map((f) => [f.key, editing.row?.[f.key] ?? ''])) : defaults}
          onSave={save}
          onCancel={() => setEditing(null)}
        />
      )}
      {deleting && (
        <ConfirmDeleteModal
          title={`Delete ${deleting.name}?`}
          warning={`Removes this ${noun} from Dispatcharr.`}
          busy={busy === 'delete'}
          onConfirm={remove}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  )
}

export function M3uPanel(props: PanelProps & { tick: number }) {
  return (
    <FeedPanel
      {...props}
      kind="m3u"
      noun="M3U account"
      defaults={{ name: '', account_type: 'STD', server_url: '', username: '', password: '', max_streams: 0, is_active: true }}
      fields={[
        { key: 'name', label: 'Name' },
        {
          key: 'account_type', label: 'Type', kind: 'select',
          options: [{ value: 'STD', label: 'Standard M3U' }, { value: 'XC', label: 'Xtream Codes' }],
        },
        { key: 'server_url', label: 'Server URL' },
        { key: 'username', label: 'Username', hint: 'Xtream Codes accounts only.' },
        { key: 'password', label: 'Password', kind: 'password', hint: 'Left as shown, the saved password is kept.' },
        { key: 'max_streams', label: 'Max streams (0 = unlimited)', kind: 'number' },
        { key: 'is_active', label: 'Active', kind: 'bool' },
      ]}
      describe={(a) => [a.account_type === 'XC' ? 'Xtream Codes' : 'Standard', a.max_streams ? `${a.max_streams} streams max` : 'no stream limit', a.server_url].filter(Boolean).join(' · ')}
    />
  )
}

export function EpgPanel(props: PanelProps & { tick: number }) {
  return (
    <FeedPanel
      {...props}
      kind="epg"
      noun="EPG source"
      defaults={{ name: '', source_type: 'xmltv', url: '', username: '', password: '', refresh_interval: 24, is_active: true }}
      fields={[
        { key: 'name', label: 'Name' },
        {
          key: 'source_type', label: 'Type', kind: 'select',
          options: [
            { value: 'xmltv', label: 'XMLTV URL' },
            { value: 'schedules_direct', label: 'Schedules Direct' },
            { value: 'dummy', label: 'Custom dummy EPG' },
          ],
        },
        { key: 'url', label: 'URL' },
        { key: 'username', label: 'Username' },
        { key: 'password', label: 'Password', kind: 'password', hint: 'Left as shown, the saved password is kept.' },
        { key: 'refresh_interval', label: 'Refresh interval', kind: 'number' },
        { key: 'is_active', label: 'Active', kind: 'bool' },
      ]}
      describe={(s) => [String(s.source_type ?? ''), s.epg_data_count !== undefined ? `${s.epg_data_count} guide entries` : '', String(s.url ?? '')].filter(Boolean).join(' · ')}
    />
  )
}
