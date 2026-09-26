import { useState } from 'react'
import clsx from 'clsx'
import ActivityFeed from '../components/ActivityFeed'
import Audit from './Audit'

const TABS = [
  { key: 'activities', label: 'Activities' },
  { key: 'audit', label: 'Audit Log' },
] as const

type TabKey = (typeof TABS)[number]['key']

// Logs — everything that gets recorded but isn't config: what the
// services themselves did (Activities, pulled from their own history) and
// what a user changed in Cortexarr (Audit Log). Two different kinds of
// "log", one section.
export default function Logs() {
  const [tab, setTab] = useState<TabKey>('activities')

  return (
    <div>
      <div className="flex gap-1 mb-4">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={clsx(
              'px-3 py-1.5 rounded-lg text-sm whitespace-nowrap border',
              tab === t.key
                ? 'bg-violet-600/20 text-violet-300 border-violet-600/40'
                : 'text-slate-400 hover:text-slate-200 border-transparent hover:bg-slate-900',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'activities' ? <ActivityFeed limit={200} /> : <Audit />}
    </div>
  )
}
