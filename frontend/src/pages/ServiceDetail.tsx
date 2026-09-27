import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import clsx from 'clsx'
import { api, ApiError } from '../api/client'
import ServiceIcon from '../components/ServiceIcon'
import SeriesLibraryList, { type SeriesLibraryItem } from '../components/SeriesLibraryList'
import DownloadingPanel from '../components/DownloadingPanel'
import MissingGrouped from '../components/MissingGrouped'
import MissingMovies from '../components/MissingMovies'
import MovieLibraryList from '../components/MovieLibraryList'
import CalendarPage from '../components/CalendarPage'
import SeerrRequests from '../components/SeerrRequests'
import SeerrIssues from '../components/SeerrIssues'
import { getServiceAccent } from '../utils/serviceAccent'

interface Service {
  id: number
  name: string
  type: string
  base_url: string
}

// Tabs per service type. The first tab is the library, and the default
// landing tab (clicking a service from the dashboard lands on its library);
// an explicit ?tab= wins when it's a tab this type has.
const TABS_BY_TYPE: Record<string, { key: string; label: string }[]> = {
  sonarr: [
    { key: 'series', label: 'Series' },
    { key: 'downloading', label: 'Downloading' },
    { key: 'missing', label: 'Missing' },
    { key: 'calendar', label: 'Calendar' },
  ],
  radarr: [
    { key: 'movies', label: 'Movies' },
    { key: 'downloading', label: 'Downloading' },
    { key: 'missing', label: 'Missing' },
    { key: 'calendar', label: 'Calendar' },
  ],
  seerr: [
    { key: 'requests', label: 'Requests' },
    { key: 'issues', label: 'Issues' },
  ],
}

export default function ServiceDetail() {
  const { id } = useParams<{ id: string }>()
  const [searchParams] = useSearchParams()
  const [service, setService] = useState<Service | null>(null)
  const [requestedTab, setTab] = useState<string | null>(() => searchParams.get('tab'))
  const tabs = TABS_BY_TYPE[service?.type ?? ''] ?? []
  const tab = tabs.some((t) => t.key === requestedTab) ? requestedTab : tabs[0]?.key
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
        {tabs.map((t) => (
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

      {!service ? null : tab === 'series' ? (
        <div className="bg-slate-925 border border-slate-800 rounded-xl p-2 sm:p-4">
          {seriesError ? (
            <p className="text-red-300 text-sm py-6 text-center">{seriesError}</p>
          ) : seriesLoading && series.length === 0 ? (
            <p className="text-slate-500 text-sm py-6 text-center">Loading…</p>
          ) : (
            <SeriesLibraryList serviceId={id ?? ''} accent={accent} series={series} />
          )}
        </div>
      ) : tab === 'movies' ? (
        <div className="bg-slate-925 border border-slate-800 rounded-xl p-2 sm:p-4">
          <MovieLibraryList serviceId={id ?? ''} accent={accent} />
        </div>
      ) : tab === 'downloading' ? (
        <DownloadingPanel serviceId={id ?? ''} serviceType={service.type} accent={accent} />
      ) : tab === 'missing' ? (
        service.type === 'radarr' ? (
          <MissingMovies serviceId={id ?? ''} accent={accent} />
        ) : (
          <MissingGrouped serviceId={id ?? ''} accent={accent} />
        )
      ) : tab === 'calendar' ? (
        <CalendarPage serviceId={id ?? ''} serviceType={service.type} />
      ) : tab === 'requests' ? (
        <SeerrRequests serviceId={id ?? ''} accent={accent} />
      ) : tab === 'issues' ? (
        <SeerrIssues serviceId={id ?? ''} accent={accent} />
      ) : null}
    </div>
  )
}
