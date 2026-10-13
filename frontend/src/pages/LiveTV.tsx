import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import clsx from 'clsx'
import { api, ApiError } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import ServiceIcon from '../components/ServiceIcon'
import OpenServiceLink from '../components/OpenServiceLink'
import PageSpinner from '../components/PageSpinner'
import RefreshButton, { useRefresh } from '../components/RefreshButton'
import { ChannelsPanel, EpgPanel, M3uPanel, StreamsPanel } from '../components/LiveTvPanels'
import { SpinnerIcon } from '../components/icons/UiIcons'
import { getServiceAccent } from '../utils/serviceAccent'

// Live TV: the control surface for Dispatcharr, kept apart from the media
// pipeline. Connection settings (URL, login) live in Settings → Services;
// this page is for operating it — streams, channels, M3U accounts, EPG.

interface Service {
  id: number
  name: string
  type: string
  base_url: string
  enabled: boolean
}

interface Overview {
  version: string | null
  channel_count: number
  m3u_accounts: number
  m3u_errors: number
  epg_sources: number
  epg_errors: number
  active_streams: number
}

const TABS = [
  { key: 'streams', label: 'Streams' },
  { key: 'channels', label: 'Channels' },
  { key: 'm3u', label: 'M3U accounts' },
  { key: 'epg', label: 'EPG sources' },
]

function Stat({ label, value, bad }: { label: string; value: string | number; bad?: boolean }) {
  return (
    <span className="metadata-pill">
      <span className="text-slate-400">{label} </span>
      <span className={bad ? 'text-red-300' : 'text-slate-100'}>{value}</span>
    </span>
  )
}

export default function LiveTV() {
  const { user } = useAuth()
  const [params, setParams] = useSearchParams()
  const [services, setServices] = useState<Service[] | null>(null)
  const [overview, setOverview] = useState<Overview | null>(null)
  const [overviewError, setOverviewError] = useState('')
  const { tick, refreshing, refresh, done } = useRefresh()

  const canAct = user?.role === 'admin' || user?.role === 'analyst'
  const isAdmin = user?.role === 'admin'

  useEffect(() => {
    api
      .get<Service[]>('/services/?type=dispatcharr')
      .then((s) => setServices(s.filter((x) => x.enabled)))
      .catch(() => setServices([]))
  }, [])

  const selected = services?.find((s) => String(s.id) === params.get('service')) ?? services?.[0]
  const tab = TABS.some((t) => t.key === params.get('tab')) ? params.get('tab')! : 'streams'
  const accent = getServiceAccent('dispatcharr')

  useEffect(() => {
    if (!selected) return
    let cancelled = false
    api
      .get<Overview>(`/livetv/${selected.id}/overview`)
      .then((o) => {
        if (cancelled) return
        setOverview(o)
        setOverviewError('')
      })
      .catch((e) => {
        if (cancelled) return
        setOverview(null)
        setOverviewError(e instanceof ApiError ? e.message : 'Could not reach Dispatcharr')
      })
      .finally(() => !cancelled && done())
    return () => {
      cancelled = true
    }
  }, [selected?.id, tick, done]) // eslint-disable-line react-hooks/exhaustive-deps

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params)
    next.set(key, value)
    setParams(next, { replace: true })
  }

  if (services === null) return <PageSpinner />

  if (services.length === 0 || !selected) {
    return (
      <div className="bg-slate-925 border border-slate-800 rounded-xl p-6">
        <h2 className="text-lg font-semibold text-slate-100 mb-2">Live TV</h2>
        <p className="text-sm text-slate-300">
          No Dispatcharr instance is set up yet.{' '}
          {isAdmin ? (
            <Link to="/settings/services?add=1" className="underline hover:text-slate-100">Add one in Settings → Services</Link>
          ) : (
            'Ask an admin to add one in Settings → Services.'
          )}
        </p>
      </div>
    )
  }

  const panel = { serviceId: selected.id, accent, canAct, isAdmin, tick }

  return (
    <div>
      <div className={clsx('rounded-xl border bg-gradient-to-r px-4 pt-3 pb-3 mb-4', accent.band, accent.border)}>
        <div className="mb-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-100">
              <ServiceIcon type="dispatcharr" className="w-6 h-6 rounded-sm shrink-0" />
              Live TV
              {services.length > 1 ? (
                <select
                  className="input w-auto ml-2"
                  value={selected.id}
                  onChange={(e) => setParam('service', e.target.value)}
                  aria-label="Dispatcharr instance"
                >
                  {services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              ) : (
                <span className="text-sm font-normal text-slate-400">{selected.name}</span>
              )}
            </h2>
            <div className="flex items-center gap-1">
              <OpenServiceLink url={selected.base_url} name={selected.name} />
              <RefreshButton onRefresh={refresh} refreshing={refreshing} label="Refresh Live TV" />
            </div>
          </div>
          <div className="flex flex-wrap gap-2 mt-2">
            {overview ? (
              <>
                <Stat label="Watching now" value={overview.active_streams} />
                <Stat label="Channels" value={overview.channel_count} />
                <Stat label="M3U accounts" value={`${overview.m3u_accounts}${overview.m3u_errors ? ` (${overview.m3u_errors} failing)` : ''}`} bad={overview.m3u_errors > 0} />
                <Stat label="EPG sources" value={`${overview.epg_sources}${overview.epg_errors ? ` (${overview.epg_errors} failing)` : ''}`} bad={overview.epg_errors > 0} />
                {overview.version && <Stat label="Dispatcharr" value={overview.version} />}
              </>
            ) : overviewError ? (
              <span className="text-sm text-red-300">{overviewError}</span>
            ) : (
              <SpinnerIcon className="w-4 h-4 text-sky-400 animate-spin" />
            )}
          </div>
        </div>
        <div className="flex gap-1 overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setParam('tab', t.key)}
              className={clsx(
                'px-3 py-1.5 rounded-lg text-sm whitespace-nowrap border',
                tab === t.key ? clsx(accent.bg, accent.text, accent.border) : 'text-slate-400 hover:text-slate-200 border-transparent hover:bg-slate-900',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'streams' ? <StreamsPanel {...panel} /> : tab === 'channels' ? <ChannelsPanel {...panel} /> : tab === 'm3u' ? <M3uPanel {...panel} /> : <EpgPanel {...panel} />}
    </div>
  )
}
