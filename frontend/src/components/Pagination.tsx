// Shared page-size select + Prev/page-numbers/Next control — used by
// DataTable (queue/wanted/calendar/series-detail/history tables) and by
// SeriesLibraryList (the series poster list), so both paginate the same way.
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100]

function pageWindow(current: number, total: number): (number | '…')[] {
  const delta = 1
  const left = Math.max(2, current - delta)
  const right = Math.min(total - 1, current + delta)
  const range: (number | '…')[] = [1]
  if (left > 2) range.push('…')
  for (let i = left; i <= right; i++) range.push(i)
  if (right < total - 1) range.push('…')
  if (total > 1) range.push(total)
  return range
}

export function PageControls({
  page, totalPages, onChange,
}: { page: number; totalPages: number; onChange: (p: number) => void }) {
  return (
    <div className="flex items-center gap-1 flex-wrap">
      <button
        onClick={() => onChange(page - 1)}
        disabled={page <= 1}
        className="px-2.5 py-1 rounded-lg text-sm border border-slate-800 text-slate-400 hover:text-slate-200 hover:bg-slate-900 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-slate-400"
      >
        Prev
      </button>
      {pageWindow(page, totalPages).map((p, i) =>
        p === '…' ? (
          <span key={`ellipsis-${i}`} className="px-2 text-slate-500 text-sm">…</span>
        ) : (
          <button
            key={p}
            onClick={() => onChange(p)}
            className={
              p === page
                ? 'px-3 py-1 rounded-lg text-sm bg-violet-600/20 text-violet-300 border border-violet-600/40'
                : 'px-3 py-1 rounded-lg text-sm border border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-900'
            }
          >
            {p}
          </button>
        ),
      )}
      <button
        onClick={() => onChange(page + 1)}
        disabled={page >= totalPages}
        className="px-2.5 py-1 rounded-lg text-sm border border-slate-800 text-slate-400 hover:text-slate-200 hover:bg-slate-900 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-slate-400"
      >
        Next
      </button>
    </div>
  )
}

export function PageSizeSelect({
  value, onChange,
}: { value: number; onChange: (n: number) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs text-slate-400 shrink-0">
      Rows per page
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="rounded-lg bg-slate-950 border border-slate-800 px-2 py-1 text-sm text-slate-100"
      >
        {PAGE_SIZE_OPTIONS.map((n) => (
          <option key={n} value={n}>{n}</option>
        ))}
      </select>
    </label>
  )
}
