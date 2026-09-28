import { useEffect, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import clsx from 'clsx'
import UserMenu from './UserMenu'
import CortexarrLogo from './icons/CortexarrLogo'
import { api } from '../api/client'
import { setTimeZone } from '../utils/time'

// Same tab/layout shape as the rest of the bsnw suite (top nav, active-tab
// underline, content panel below) — see Positioning decision in project
// memory — with Cortexarr's own violet/teal palette instead of pkt*'s gold.
const TABS = [
  { to: '/', label: 'Dashboard' },
  { to: '/tracking', label: 'Tracking' },
  { to: '/alerts', label: 'Notifications' },
  { to: '/history', label: 'History' },
]

export default function Layout() {
  // Pages render once the time zone is known, so no date is drawn in the
  // wrong zone first. A failed load falls back to the browser's own zone.
  const [zoneReady, setZoneReady] = useState(false)
  useEffect(() => {
    api
      .get<{ timezone?: string }>('/settings/')
      .then((s) => setTimeZone(s.timezone))
      .catch(() => setTimeZone(null))
      .finally(() => setZoneReady(true))
  }, [])

  return (
    <div className="min-h-screen bg-slate-950">
      <header className="border-b border-slate-800 bg-slate-925/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="flex items-center justify-between h-14">
            <div className="flex items-center gap-2 font-semibold text-slate-100">
              <CortexarrLogo className="w-6 h-6 shrink-0" />
              Cortexarr
            </div>
            <UserMenu />
          </div>
          <nav className="flex gap-1 overflow-x-auto pb-2 -mb-px">
            {TABS.map((tab) => (
              <NavLink
                key={tab.to}
                to={tab.to}
                className={({ isActive }) =>
                  clsx(
                    'px-3 py-1.5 rounded-lg text-sm whitespace-nowrap transition-colors',
                    isActive
                      ? 'bg-violet-600/20 text-violet-300 border border-violet-600/40'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900 border border-transparent',
                  )
                }
                end={tab.to === '/'}
              >
                {tab.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>
      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-6">
        {zoneReady && <Outlet />}
      </main>
    </div>
  )
}
