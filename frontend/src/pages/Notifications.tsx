import { Fragment, useState } from 'react'
import clsx from 'clsx'
import Alerts from './Alerts'
import Rules from './Rules'
import ActivityFeed from '../components/ActivityFeed'
import Audit from './Audit'

const TABS = [
  { key: 'alerts', label: 'Alerts' },
  { key: 'rules', label: 'Rules' },
  { key: 'activities', label: 'Activities' },
  { key: 'audit', label: 'Audit Log' },
] as const

type TabKey = (typeof TABS)[number]['key']

// Everything about what's happening and what's gone wrong, one page:
// current problems, your alert rules (its own tab so managing them doesn't
// compete for space with what's actively wrong), the cross-service
// activity feed, and the config-change audit log. Was two separate top-nav
// destinations (Alerts, and Logs with its own Activities/Audit Log split)
// — now one.
export default function Notifications() {
  const [tab, setTab] = useState<TabKey>('alerts')

  return (
    <div>
      <div className="flex items-center gap-1 mb-4">
        {TABS.map((t) => (
          <Fragment key={t.key}>
            <button
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
            {/* Alerts + Rules are one thing (what's wrong, and what decides
                what notifies); Activities + Audit Log are another (a log of
                what happened). The divider marks that split. */}
            {t.key === 'rules' && <span className="w-px h-5 bg-slate-800 mx-1" />}
          </Fragment>
        ))}
      </div>

      {tab === 'alerts' ? (
        <Alerts />
      ) : tab === 'rules' ? (
        <Rules />
      ) : tab === 'activities' ? (
        <ActivityFeed limit={200} />
      ) : (
        <Audit />
      )}
    </div>
  )
}
