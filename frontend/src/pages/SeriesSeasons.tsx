import { useEffect, useRef, useState } from 'react'
import { useNavigate, Link, useParams, useSearchParams } from 'react-router-dom'
import clsx from 'clsx'
import { api, ApiError } from '../api/client'
import MonitoredToggle from '../components/MonitoredToggle'
import ConfirmDeleteModal from '../components/ConfirmDeleteModal'
import HistoryModal from '../components/HistoryModal'
import CalendarModal from '../components/CalendarModal'
import { CalendarIcon, ChevronIcon, HistoryIcon, RefreshIcon, SearchIcon, TrashIcon } from '../components/icons/UiIcons'
import { getServiceAccent } from '../utils/serviceAccent'

interface Service {
  id: number
  name: string
  type: string
}

interface SeriesDetail {
  id: number
  title: string
  status: string
  monitored: boolean
  network: string
  overview: string
  poster_url: string
  fanart_url: string
  year_range: string
  season_count: number
  episode_file_count: number
  episode_count: number
  size_on_disk: number
  seasons: SeasonSummary[]
}

interface SeasonSummary {
  season_number: number
  monitored: boolean
  episode_file_count: number
  episode_count: number
  size_on_disk: number
  percent_complete: number
}

interface EpisodeItem {
  id: number
  episode_number: number
  title: string
  air_date: string | null
  monitored: boolean
  has_file: boolean
  episode_file_id: number | null
}

interface HistoryRow {
  id: number
  event_type: string
  episode: string
  source_title: string | null
  quality: string
  date: string | null
}

function fmtBytes(n: number) {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${units[i]}`
}

function fmtDate(v: string | null) {
  if (!v) return '—'
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString()
}

function episodeStatus(ep: EpisodeItem): { label: string; className: string } {
  if (ep.has_file) return { label: 'Downloaded', className: 'text-teal-300' }
  if (ep.air_date && new Date(ep.air_date).getTime() > Date.now()) return { label: 'Upcoming', className: 'text-slate-400' }
  return { label: 'Missing', className: 'text-amber-300' }
}

export default function SeriesSeasons() {
  const { id, seriesId } = useParams<{ id: string; seriesId: string }>()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const seasonRefs = useRef<Record<number, HTMLDivElement | null>>({})
  const [service, setService] = useState<Service | null>(null)
  const [series, setSeries] = useState<SeriesDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const accent = getServiceAccent(service?.type ?? '')

  const [expandedSeason, setExpandedSeason] = useState<number | null>(null)
  const [episodesBySeason, setEpisodesBySeason] = useState<Record<number, EpisodeItem[]>>({})
  const [episodesLoading, setEpisodesLoading] = useState(false)
  const [seasonBusy, setSeasonBusy] = useState<Set<number>>(new Set())
  const [episodeBusy, setEpisodeBusy] = useState<Set<number>>(new Set())
  const [actionError, setActionError] = useState('')

  const [deleteSeriesOpen, setDeleteSeriesOpen] = useState(false)
  const [deleteEpisode, setDeleteEpisode] = useState<EpisodeItem | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  const [historyOpen, setHistoryOpen] = useState<number | null>(null)
  const [historyRows, setHistoryRows] = useState<HistoryRow[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)

  // Series-wide (not per-season) Calendar/History, opened from the header.
  const [seriesHistoryOpen, setSeriesHistoryOpen] = useState(false)
  const [seriesHistoryRows, setSeriesHistoryRows] = useState<HistoryRow[]>([])
  const [seriesHistoryLoading, setSeriesHistoryLoading] = useState(false)
  // null = closed; a Date = open, jumped to that month (e.g. an upcoming
  // episode's air date, or "now" from the header button).
  const [seriesCalendarMonth, setSeriesCalendarMonth] = useState<Date | null>(null)

  useEffect(() => {
    if (!id) return
    api.get<Service>(`/services/${id}`).then(setService).catch(() => setService(null))
  }, [id])

  async function loadSeries() {
    if (!id || !seriesId) return
    setLoading(true)
    setError('')
    try {
      setSeries(await api.get<SeriesDetail>(`/services/${id}/series/${seriesId}`))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadSeries()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, seriesId])

  async function loadEpisodes(seasonNumber: number) {
    if (!id || !seriesId) return
    setEpisodesLoading(true)
    try {
      const eps = await api.get<EpisodeItem[]>(`/services/${id}/series/${seriesId}/seasons/${seasonNumber}/episodes`)
      setEpisodesBySeason((prev) => ({ ...prev, [seasonNumber]: eps }))
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Failed to load episodes')
    } finally {
      setEpisodesLoading(false)
    }
  }

  async function refreshSeason(seasonNumber: number) {
    // Re-pulls both the season's own summary (size, monitored, % complete —
    // lives on the series object) and its episode rows, so "Refresh" visibly
    // updates the whole season, not just the episode list silently re-fetching
    // the same data.
    setSeasonBusy((b) => new Set(b).add(seasonNumber))
    try {
      await Promise.all([loadSeries(), loadEpisodes(seasonNumber)])
    } finally {
      setSeasonBusy((b) => {
        const n = new Set(b)
        n.delete(seasonNumber)
        return n
      })
    }
  }

  // Arriving from the Calendar with a ?season= param (that entry's air date
  // falls in this season) jumps straight to it, expanded and scrolled into
  // view, instead of leaving the user to hunt through the accordion.
  const seasonParam = searchParams.get('season')
  useEffect(() => {
    if (!series || seasonParam == null) return
    const seasonNumber = Number(seasonParam)
    if (Number.isNaN(seasonNumber)) return
    setExpandedSeason(seasonNumber)
    if (!episodesBySeason[seasonNumber]) loadEpisodes(seasonNumber)
    requestAnimationFrame(() => {
      seasonRefs.current[seasonNumber]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seasonParam, series])

  function toggleSeason(seasonNumber: number) {
    if (expandedSeason === seasonNumber) {
      setExpandedSeason(null)
      return
    }
    setExpandedSeason(seasonNumber)
    if (!episodesBySeason[seasonNumber]) loadEpisodes(seasonNumber)
  }

  async function toggleSeriesMonitored() {
    if (!id || !seriesId || !series) return
    const next = !series.monitored
    setSeries({ ...series, monitored: next })
    try {
      await api.patch(`/services/${id}/series/${seriesId}/monitored`, { monitored: next })
    } catch (err) {
      setSeries((prev) => (prev ? { ...prev, monitored: !next } : prev))
      setActionError(err instanceof ApiError ? err.message : 'Failed to update')
    }
  }

  async function toggleSeasonMonitored(season: SeasonSummary) {
    if (!id || !seriesId) return
    setSeasonBusy((b) => new Set(b).add(season.season_number))
    const next = !season.monitored
    try {
      await api.patch(`/services/${id}/series/${seriesId}/seasons/${season.season_number}/monitored`, { monitored: next })
      setSeries((prev) =>
        prev
          ? { ...prev, seasons: prev.seasons.map((s) => (s.season_number === season.season_number ? { ...s, monitored: next } : s)) }
          : prev,
      )
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Failed to update')
    } finally {
      setSeasonBusy((b) => {
        const n = new Set(b)
        n.delete(season.season_number)
        return n
      })
    }
  }

  async function toggleEpisodeMonitored(ep: EpisodeItem, seasonNumber: number) {
    if (!id) return
    setEpisodeBusy((b) => new Set(b).add(ep.id))
    const next = !ep.monitored
    try {
      await api.patch(`/services/${id}/episodes/${ep.id}/monitored`, { monitored: next })
      setEpisodesBySeason((prev) => ({
        ...prev,
        [seasonNumber]: (prev[seasonNumber] || []).map((e) => (e.id === ep.id ? { ...e, monitored: next } : e)),
      }))
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Failed to update')
    } finally {
      setEpisodeBusy((b) => {
        const n = new Set(b)
        n.delete(ep.id)
        return n
      })
    }
  }

  async function searchSeason(seasonNumber: number) {
    if (!id || !seriesId) return
    setSeasonBusy((b) => new Set(b).add(seasonNumber))
    try {
      await api.post(`/services/${id}/series/${seriesId}/seasons/${seasonNumber}/search`)
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Failed to trigger search')
    } finally {
      setSeasonBusy((b) => {
        const n = new Set(b)
        n.delete(seasonNumber)
        return n
      })
    }
  }

  async function searchEpisode(ep: EpisodeItem) {
    if (!id) return
    setEpisodeBusy((b) => new Set(b).add(ep.id))
    try {
      await api.post(`/services/${id}/episodes/${ep.id}/search`)
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Failed to trigger search')
    } finally {
      setEpisodeBusy((b) => {
        const n = new Set(b)
        n.delete(ep.id)
        return n
      })
    }
  }

  async function openHistory(seasonNumber: number) {
    if (!id || !seriesId) return
    setHistoryOpen(seasonNumber)
    setHistoryLoading(true)
    try {
      setHistoryRows(await api.get<HistoryRow[]>(`/services/${id}/series/${seriesId}/seasons/${seasonNumber}/history`))
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Failed to load history')
    } finally {
      setHistoryLoading(false)
    }
  }

  async function openSeriesHistory() {
    if (!id || !seriesId) return
    setSeriesHistoryOpen(true)
    setSeriesHistoryLoading(true)
    try {
      setSeriesHistoryRows(await api.get<HistoryRow[]>(`/services/${id}/series/${seriesId}/history`))
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Failed to load history')
    } finally {
      setSeriesHistoryLoading(false)
    }
  }


  async function confirmDeleteSeries() {
    if (!id || !seriesId) return
    setDeleteBusy(true)
    try {
      await api.delete(`/services/${id}/series/${seriesId}`)
      navigate(`/services/${id}?tab=series`)
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Failed to delete')
      setDeleteBusy(false)
    }
  }

  async function confirmDeleteEpisode() {
    if (!id || !deleteEpisode || deleteEpisode.episode_file_id == null || expandedSeason == null) return
    setDeleteBusy(true)
    try {
      await api.delete(`/services/${id}/episodefiles/${deleteEpisode.episode_file_id}`)
      setEpisodesBySeason((prev) => ({
        ...prev,
        [expandedSeason]: (prev[expandedSeason] || []).map((e) =>
          e.id === deleteEpisode.id ? { ...e, has_file: false, episode_file_id: null } : e,
        ),
      }))
      setDeleteEpisode(null)
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Failed to delete')
    } finally {
      setDeleteBusy(false)
    }
  }

  return (
    <div>
      <div className="mb-4">
        <Link to={`/services/${id}?tab=series`} className="text-xs text-slate-400 hover:text-slate-200">
          ← Back to Series
        </Link>
      </div>

      {error ? (
        <p className="text-red-300 text-sm py-6 text-center">{error}</p>
      ) : loading && !series ? (
        <p className="text-slate-500 text-sm py-6 text-center">Loading…</p>
      ) : series ? (
        <>
          {/* Header: fanart banner + title/metadata overlay */}
          <div className="relative rounded-xl overflow-hidden border border-slate-800 mb-4">
            {series.fanart_url ? (
              <img src={series.fanart_url} alt="" className="w-full h-40 sm:h-56 object-cover" />
            ) : (
              <div className="w-full h-24 bg-slate-925" />
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/70 to-transparent" />
            <div className="absolute inset-x-0 bottom-0 p-4 sm:p-5 flex items-end justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  {series.fanart_url && (
                    <img
                      src={series.fanart_url}
                      alt=""
                      className="h-7 sm:h-9 w-12 sm:w-16 rounded object-cover shrink-0 border border-slate-700"
                    />
                  )}
                  <h2 className="text-xl sm:text-2xl font-semibold text-slate-100 truncate">{series.title}</h2>
                </div>
                <div className="text-xs sm:text-sm text-slate-300 mt-2 flex flex-wrap gap-1.5">
                  {series.year_range && <span className="metadata-pill">{series.year_range}</span>}
                  <span className="metadata-pill capitalize">{series.status}</span>
                  <span className="metadata-pill">{series.season_count} season{series.season_count === 1 ? '' : 's'}</span>
                  <span className="metadata-pill">{series.episode_file_count} / {series.episode_count} episodes</span>
                  {series.network && <span className="metadata-pill">{series.network}</span>}
                  <span className="metadata-pill">{fmtBytes(series.size_on_disk)}</span>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <MonitoredToggle
                  monitored={series.monitored}
                  busy={false}
                  accent={accent}
                  onClick={toggleSeriesMonitored}
                  variant="label"
                />
                <button
                  onClick={() => setSeriesCalendarMonth(new Date())}
                  title="Calendar for this series"
                  className="p-2 rounded-lg border border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors"
                >
                  <CalendarIcon className="w-4 h-4" />
                </button>
                <button
                  onClick={openSeriesHistory}
                  title="History for this series"
                  className="p-2 rounded-lg border border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors"
                >
                  <HistoryIcon className="w-4 h-4" />
                </button>
                {/* Deliberate gap — Delete is destructive and shouldn't sit
                    flush against the other, harmless header actions. */}
                <div className="w-6" />
                <button
                  onClick={() => setDeleteSeriesOpen(true)}
                  title="Delete series"
                  className="p-2 rounded-lg border border-slate-700 text-slate-400 hover:text-red-300 hover:border-red-900 hover:bg-red-950/30 transition-colors"
                >
                  <TrashIcon className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>

          {actionError && (
            <p className="text-red-300 text-xs mb-3 bg-red-950/50 border border-red-900 rounded-lg px-3 py-2">{actionError}</p>
          )}

          {/* Seasons — accordion, one open at a time */}
          <div className="flex flex-col gap-2">
            {series.seasons.map((season) => {
              const isOpen = expandedSeason === season.season_number
              const episodes = episodesBySeason[season.season_number]
              return (
                <div
                  key={season.season_number}
                  ref={(el) => {
                    seasonRefs.current[season.season_number] = el
                  }}
                  className="bg-slate-925 border border-slate-800 rounded-xl overflow-hidden"
                >
                  <button
                    onClick={() => toggleSeason(season.season_number)}
                    className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-900/60 transition-colors"
                  >
                    <span className="flex items-center gap-2 text-sm font-medium text-slate-100">
                      <ChevronIcon open={isOpen} className="w-4 h-4 text-slate-500" />
                      {season.season_number === 0 ? 'Specials' : `Season ${season.season_number}`}
                    </span>
                    <span className="text-xs text-slate-500">
                      {season.episode_file_count} / {season.episode_count} episodes · {fmtBytes(season.size_on_disk)}
                    </span>
                  </button>

                  {isOpen && (
                    <div className="border-t border-slate-800 p-3 sm:p-4">
                      <div className="flex items-center gap-2 mb-3 flex-wrap">
                        <MonitoredToggle
                          monitored={season.monitored}
                          busy={seasonBusy.has(season.season_number)}
                          accent={accent}
                          onClick={() => toggleSeasonMonitored(season)}
                          variant="label"
                        />
                        <button
                          onClick={() => refreshSeason(season.season_number)}
                          disabled={seasonBusy.has(season.season_number)}
                          className="btn-secondary flex items-center gap-1.5 disabled:opacity-50"
                        >
                          <RefreshIcon className={clsx('w-3.5 h-3.5', seasonBusy.has(season.season_number) && 'animate-spin')} />
                          {seasonBusy.has(season.season_number) ? 'Refreshing…' : 'Refresh'}
                        </button>
                        <button
                          onClick={() => searchSeason(season.season_number)}
                          disabled={seasonBusy.has(season.season_number)}
                          className="btn-secondary flex items-center gap-1.5 disabled:opacity-50"
                        >
                          <SearchIcon className="w-3.5 h-3.5" /> Search
                        </button>
                        <button
                          onClick={() => openHistory(season.season_number)}
                          className="btn-secondary flex items-center gap-1.5"
                        >
                          <HistoryIcon className="w-3.5 h-3.5" /> History
                        </button>
                      </div>

                      {episodesLoading && !episodes ? (
                        <p className="text-slate-500 text-sm py-4 text-center">Loading episodes…</p>
                      ) : !episodes || episodes.length === 0 ? (
                        <p className="text-slate-500 text-sm py-4 text-center">No episodes found.</p>
                      ) : (
                        <div className="overflow-x-auto -mx-3 sm:mx-0">
                          <table className="w-full text-sm min-w-[560px] sm:min-w-0">
                            <thead>
                              <tr className="text-left text-slate-400 border-b border-slate-800">
                                <th className="font-medium py-2 px-3">#</th>
                                <th className="font-medium py-2 px-3">Title</th>
                                <th className="font-medium py-2 px-3">Air date</th>
                                <th className="font-medium py-2 px-3">Status</th>
                                <th className="font-medium py-2 px-3">Monitored</th>
                                <th className="font-medium py-2 px-3"></th>
                              </tr>
                            </thead>
                            <tbody>
                              {episodes.map((ep) => {
                                const st = episodeStatus(ep)
                                const busy = episodeBusy.has(ep.id)
                                return (
                                  <tr key={ep.id} className="border-b border-slate-900 last:border-0 hover:bg-slate-900/40">
                                    <td className="py-2 px-3 text-slate-100">{ep.episode_number}</td>
                                    <td className="py-2 px-3 text-slate-100">{ep.title || '—'}</td>
                                    <td className="py-2 px-3 text-slate-100">{fmtDate(ep.air_date)}</td>
                                    <td className={clsx('py-2 px-3', st.className)}>
                                      {st.label === 'Upcoming' && ep.air_date ? (
                                        <button
                                          onClick={() => setSeriesCalendarMonth(new Date(ep.air_date as string))}
                                          title="View on calendar"
                                          className="hover:underline"
                                        >
                                          {st.label}
                                        </button>
                                      ) : (
                                        st.label
                                      )}
                                    </td>
                                    <td className="py-2 px-3">
                                      <MonitoredToggle
                                        monitored={ep.monitored}
                                        busy={busy}
                                        accent={accent}
                                        onClick={() => toggleEpisodeMonitored(ep, season.season_number)}
                                      />
                                    </td>
                                    <td className="py-2 px-3">
                                      {ep.has_file ? (
                                        <button
                                          onClick={() => setDeleteEpisode(ep)}
                                          disabled={busy}
                                          title="Delete episode file"
                                          className="p-1.5 rounded-lg border border-slate-700 text-slate-400 hover:text-red-300 hover:border-red-900 hover:bg-red-950/30 disabled:opacity-50 transition-colors"
                                        >
                                          <TrashIcon className="w-3.5 h-3.5" />
                                        </button>
                                      ) : (
                                        <button
                                          onClick={() => searchEpisode(ep)}
                                          disabled={busy}
                                          title="Search for episode"
                                          className={clsx(
                                            'p-1.5 rounded-lg border border-slate-700 text-slate-400 hover:border-slate-600 disabled:opacity-50 transition-colors',
                                            accent.text,
                                          )}
                                        >
                                          <SearchIcon className="w-3.5 h-3.5" />
                                        </button>
                                      )}
                                    </td>
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      ) : null}

      {deleteSeriesOpen && series && (
        <ConfirmDeleteModal
          title={`Delete "${series.title}"`}
          warning="This removes the series from Sonarr."
          busy={deleteBusy}
          onConfirm={confirmDeleteSeries}
          onCancel={() => setDeleteSeriesOpen(false)}
        />
      )}

      {deleteEpisode && (
        <ConfirmDeleteModal
          title={`Delete episode ${deleteEpisode.episode_number} file`}
          warning="This deletes the episode's file from disk."
          busy={deleteBusy}
          onConfirm={confirmDeleteEpisode}
          onCancel={() => setDeleteEpisode(null)}
        />
      )}

      {historyOpen != null && (
        <HistoryModal
          title={`Season ${historyOpen === 0 ? '(Specials)' : historyOpen} history`}
          rows={historyRows}
          loading={historyLoading}
          onClose={() => setHistoryOpen(null)}
        />
      )}

      {seriesHistoryOpen && series && (
        <HistoryModal
          title={`"${series.title}" history`}
          rows={seriesHistoryRows}
          loading={seriesHistoryLoading}
          onClose={() => setSeriesHistoryOpen(false)}
        />
      )}

      {seriesCalendarMonth && series && id && seriesId && (
        <CalendarModal
          title={`"${series.title}" calendar`}
          serviceId={id}
          seriesId={seriesId}
          initialMonth={seriesCalendarMonth}
          onClose={() => setSeriesCalendarMonth(null)}
        />
      )}
    </div>
  )
}
