import { NavLink, Outlet } from 'react-router-dom'
import clsx from 'clsx'
import { useAuth } from '../auth/AuthContext'

// Everything that was scattered across the user menu's Services/Monitoring
// sections and the standalone Settings/API tokens entries, brought
// together as tabs of one management hub. Alerts and Logs moved back out
// to their own top-nav Notifications tab (alerts, activity and audit are
// things you watch, not something you configure). The User menu's own
// section (My notifications, Change password, Log out) stays where it
// was — this is the admin/management surface, not personal account settings.
const TABS = [
  { to: '/settings', label: 'General', end: true },
  { to: '/settings/notifications', label: 'Notifications' },
  { to: '/settings/services', label: 'Services' },
  { to: '/settings/users', label: 'Users', adminOnly: true },
  { to: '/settings/tokens', label: 'API tokens' },
]

export default function SettingsLayout() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const tabs = TABS.filter((t) => !t.adminOnly || isAdmin)

  return (
    <div>
      <h2 className="text-lg font-semibold text-slate-100 mb-3">Settings</h2>
      <nav className="flex gap-1 overflow-x-auto pb-2 mb-4 border-b border-slate-800">
        {tabs.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className={({ isActive }) =>
              clsx(
                'px-3 py-1.5 rounded-lg text-sm whitespace-nowrap transition-colors',
                isActive
                  ? 'bg-violet-600/20 text-violet-300 border border-violet-600/40'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900 border border-transparent',
              )
            }
          >
            {t.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  )
}
