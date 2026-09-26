import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import clsx from 'clsx'
import { api, ApiError } from '../api/client'
import ServiceIcon from '../components/ServiceIcon'
import SeriesLibraryList, { type SeriesLibraryItem } from '../components/SeriesLibraryList'
import DownloadingPanel from '../components/DownloadingPanel'
import MissingGrouped from '../components/MissingGrouped'
import CalendarPage from '../components/CalendarPage'
import { getServiceAccent } from '../utils/serviceAccent'

interface Service {
  id: number
  name: string
  type: string
  base_url: string
}

const TABS = [
  { key: 'series', label: 'Series' },
  { key: 'downloading', label: 'Downloading' },
  { key: 'missing', label: 'Missing' },
  { key: 'calendar', label: 'Calendar' },
] as const

type TabKey = (typeof TABS)[number]['key']

export default function ServiceDetail() {
  const { id } = useParams<{ id: string }>()
  const [searchParams] = useSearchParams()
  const [service, setService] = useState<Service | null>(null)
  const [tab, setTab] = useState<TabKey>(() => {
    // Default landing tab is Series (clicking a service from the dashboard
    // should land on its library) — an explicit ?tab= always wins.
    const requested = searchParams.get('tab')
    return TABS.some((t) => t.key === requested) ? (requested as TabKey) : 'series'
  })
  const accent = getServiceAccent(service?.type ?? '')

  const [series, setSeries] = useState<SeriesLibraryItem[]>([])
  const [seriesLoading, setSeriesLoading] = useState(true)
  const [seriesError, setSeriesError] = useState('')

  useEffect(() => {
    if (!id) return
    api.get<Service>(`/services/${id}`).then(setService).catch(() => setService(null))
  }, [id])

  useEffect(() => {
    if (!id || tab !== 'series') return
    let cancelled = false
    async function load() {
      setSeriesLoading(true)
      setSeriesError('')
      try {
        const data = await api.get<SeriesLibraryItem[]>(`/services/${id}/detail/series`)
        if (!cancelled) setSeries(data)
      } catch (err) {
        if (!cancelled) setSeriesError(err instanceof ApiError ? err.message : 'Failed to load')
      } finally {
        if (!cancelled) setSeriesLoading(false)
      }
    }
    load()
    const interval = setInterval(load, 20000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [id, tab])

  return (
    <div>
      <div className="mb-4">
        <Link to="/" className="text-xs text-slate-400 hover:text-slate-200">
          ← Back to dashboard
        </Link>
        <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-100 mt-1">
          {service && <ServiceIcon type={service.type} className="w-6 h-6 rounded-sm shrink-0" />}
          {service ? service.name : 'Service'}
        </h2>
        {service && (
          <p className="text-xs text-slate-500">
            {service.type} ·{' '}
            <a
              href={service.base_url}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-slate-300 hover:underline"
            >
              {service.base_url}
            </a>
          </p>
        )}
      </div>

      <div className="flex gap-1 mb-4 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={clsx(
              'px-3 py-1.5 rounded-lg text-sm whitespace-nowrap border',
              tab === t.key
                ? clsx(accent.bg, accent.text, accent.border)
                : 'text-slate-400 hover:text-slate-200 border-transparent hover:bg-slate-900',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'series' ? (
        <div className="bg-slate-925 border border-slate-800 rounded-xl p-2 sm:p-4">
          {seriesError ? (
            <p className="text-red-300 text-sm py-6 text-center">{seriesError}</p>
          ) : seriesLoading && series.length === 0 ? (
            <p className="text-slate-500 text-sm py-6 text-center">Loading…</p>
          ) : (
            <SeriesLibraryList serviceId={id ?? ''} accent={accent} series={series} />
          )}
        </div>
      ) : tab === 'downloading' ? (
        <DownloadingPanel serviceId={id ?? ''} accent={accent} />
      ) : tab === 'missing' ? (
        <MissingGrouped serviceId={id ?? ''} accent={accent} />
      ) : (
        <CalendarPage serviceId={id ?? ''} />
      )}
    </div>
  )
}
