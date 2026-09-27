import { Navigate, Route, Routes } from 'react-router-dom'
import type { ReactNode } from 'react'
import { AuthProvider, useAuth } from './auth/AuthContext'
import Layout from './components/Layout'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Services from './pages/Services'
import ServiceDetail from './pages/ServiceDetail'
import SeriesSeasons from './pages/SeriesSeasons'
import MovieDetail from './pages/MovieDetail'
import SettingsLayout from './pages/SettingsLayout'
import SettingsGeneral from './pages/SettingsGeneral'
import SettingsNotifications from './pages/SettingsNotifications'
import Users from './pages/Users'
import ApiTokens from './pages/ApiTokens'
import Tracking from './pages/Tracking'
import Notifications from './pages/Notifications'
import MyNotifications from './pages/MyNotifications'

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) return <div className="min-h-screen bg-slate-950" />
  if (!user) return <Navigate to="/login" replace />
  return <>{children}</>
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="services/:id" element={<ServiceDetail />} />
        <Route path="services/:id/series/:seriesId" element={<SeriesSeasons />} />
        <Route path="services/:id/movies/:movieId" element={<MovieDetail />} />
        {/* The management surface — was scattered across the user menu's
            Services/Monitoring sections; now one tabbed hub. Alerts/Logs
            moved back out to their own top-level Notifications tab. */}
        <Route path="settings" element={<SettingsLayout />}>
          <Route index element={<SettingsGeneral />} />
          <Route path="notifications" element={<SettingsNotifications />} />
          <Route path="services" element={<Services />} />
          <Route path="users" element={<Users />} />
          <Route path="tokens" element={<ApiTokens />} />
        </Route>
        <Route path="tracking" element={<Tracking />} />
        {/* Alerts, the activity feed, and the audit log — one top-nav
            destination named "Notifications", after Tracking. Keeps the
            original /alerts path so it doesn't collide with the personal
            page below, which is user-level, not this. */}
        <Route path="alerts" element={<Notifications />} />
        {/* Personal channel targets (user menu → User → My notifications) —
            unrelated to the system-level "Notifications" tab above; stays
            at its original path. */}
        <Route path="notifications" element={<MyNotifications />} />
      </Route>
    </Routes>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  )
}
