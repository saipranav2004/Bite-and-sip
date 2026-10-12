import { Navigate, useLocation } from 'react-router-dom'
import { Spinner } from '../../components/ui'
import { useStaffSession } from '../../state/staffSession'

export function RequireStaff({ ownerOnly = false, children }: { ownerOnly?: boolean; children: React.ReactNode }) {
  const { profile, loading } = useStaffSession()
  const location = useLocation()
  if (loading) return <div className="grid min-h-dvh place-items-center"><Spinner label="Checking your session" /></div>
  if (!profile) return <Navigate to="/staff/login" replace state={{ from: location.pathname }} />
  if (ownerOnly && profile.role !== 'owner') return <Navigate to="/staff" replace />
  return <>{children}</>
}
