import { useCallback, useState } from 'react'
import clsx from 'clsx'
import { RefreshIcon } from './icons/UiIcons'

// Reload one card or one page now, without waiting for its poll interval.
// `tick` goes into the loader effect's deps so bumping it re-runs the load;
// the loader calls `done()` when it settles so the icon stops spinning.
export function useRefresh() {
  const [tick, setTick] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const refresh = useCallback(() => {
    setRefreshing(true)
    setTick((t) => t + 1)
  }, [])
  const done = useCallback(() => setRefreshing(false), [])
  return { tick, refreshing, refresh, done }
}

// Sits beside OpenServiceLink in a card header, so it's styled to match;
// the click stops at the button so the card underneath doesn't navigate.
export default function RefreshButton({
  onRefresh, refreshing, label,
}: { onRefresh: () => void; refreshing: boolean; label: string }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={refreshing}
      onClick={(e) => {
        e.stopPropagation()
        onRefresh()
      }}
      onKeyDown={(e) => e.stopPropagation()}
      className="p-1 rounded-md text-slate-300 hover:text-slate-100 hover:bg-slate-900/70 transition-colors disabled:cursor-default"
    >
      <RefreshIcon className={clsx('w-4 h-4', refreshing && 'animate-spin')} />
    </button>
  )
}
