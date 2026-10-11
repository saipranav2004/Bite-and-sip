import { useEffect, useState } from 'react'
import { Navigate, NavLink, Outlet, useLocation } from 'react-router-dom'
import { isDemo } from '../../backend'
import {
  IconBoard, IconBox, IconChart, IconHistory, IconLogOut, IconMenuBook, IconMore, IconSettings, IconTrend, IconUsers, IconWallet,
} from '../../components/icons'
import { Dialog, Spinner, Wordmark } from '../../components/ui'
import type { StaffProfile } from '../../lib/types'
import { usePublicData } from '../../state/publicData'
import { useStaffSession } from '../../state/staffSession'

export function RequireStaff({ ownerOnly = false, children }: { ownerOnly?: boolean; children: React.ReactNode }) {
  const { profile, loading } = useStaffSession()
  const location = useLocation()
  if (loading) return <div className="grid min-h-dvh place-items-center"><Spinner label="Checking your session" /></div>
  if (!profile) return <Navigate to="/staff/login" replace state={{ from: location.pathname }} />
  if (ownerOnly && profile.role !== 'owner') return <Navigate to="/staff" replace />
  return <>{children}</>
}

type Icon = typeof IconBoard
interface NavEntry {
  to: string
  label: string
  icon: Icon
  end?: boolean
  owner?: boolean
}

const GROUPS: { label: string; items: NavEntry[] }[] = [
  {
    label: 'Operate',
    items: [
      { to: '/staff', label: 'Orders', icon: IconBoard, end: true },
      { to: '/staff/menu', label: 'Menu', icon: IconMenuBook },
      { to: '/staff/inventory', label: 'Inventory', icon: IconBox },
    ],
  },
  {
    label: 'Money',
    items: [
      { to: '/staff/reports', label: 'Sales', icon: IconChart, owner: true },
      { to: '/staff/profit', label: 'Profit & loss', icon: IconTrend, owner: true },
      { to: '/staff/expenses', label: 'Expenses', icon: IconWallet, owner: true },
    ],
  },
  {
    label: 'Admin',
    items: [
      { to: '/staff/team', label: 'Team', icon: IconUsers, owner: true },
      { to: '/staff/audit', label: 'Audit log', icon: IconHistory, owner: true },
      { to: '/staff/settings', label: 'Settings', icon: IconSettings, owner: true },
    ],
  },
]

/** Tracked items at or below their low-stock level. */
function useLowStockCount() {
  const { data } = usePublicData()
  if (!data) return 0
  const live = new Set(data.menu.items.map((i) => i.id))
  return data.stock.filter((s) => live.has(s.menu_item_id) && s.on_hand <= s.low_at).length
}

export function StaffLayout() {
  const { profile, signOut } = useStaffSession()
  const { data } = usePublicData()
  const location = useLocation()
  const [moreOpen, setMoreOpen] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const lowStock = useLowStockCount()

  useEffect(() => setMoreOpen(false), [location.pathname])

  if (!profile) return null
  const owner = profile.role === 'owner'
  const groups = GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => !i.owner || owner) })).filter((g) => g.items.length)
  const all = groups.flatMap((g) => g.items)
  const tabs = owner ? all.filter((i) => ['/staff', '/staff/menu', '/staff/reports'].includes(i.to)) : all
  const path = location.pathname.replace(/\/+$/, '')
  const moreActive = owner && !tabs.some((t) => (t.end ? path === t.to : path.startsWith(t.to)))
  const open = data?.settings.is_open
  const doSignOut = async () => {
    setSigningOut(true)
    await signOut()
  }
  const badgeFor = (to: string) => (to === '/staff/inventory' && lowStock > 0 ? lowStock : 0)

  return (
    <div className="admin min-h-dvh">
      {isDemo && (
        <div className="relative z-20 bg-brand px-4 py-1.5 text-center text-xs font-bold text-ink no-print md:pl-20 xl:pl-64">
          Demo mode — data lives in this browser only. Connect Supabase for the real café.
        </div>
      )}

      {/* Sidebar (laptop) / icon rail (tablet) */}
      <aside className="no-print fixed inset-y-0 left-0 z-30 hidden w-16 flex-col bg-ink text-white md:flex xl:w-60" aria-label="Staff console">
        <div className="flex h-16 shrink-0 items-center px-4 xl:px-5">
          <span className="hidden xl:block"><Wordmark onDark className="text-[15px]" /></span>
          <span className="grid size-8 place-items-center rounded-lg bg-brand text-sm font-extrabold text-ink xl:hidden" aria-hidden="true">B&amp;S</span>
        </div>
        <nav aria-label="Staff" className="flex-1 overflow-y-auto px-2 pb-4 xl:px-3">
          {groups.map((g) => (
            <div key={g.label} className="mt-4 first:mt-1">
              <p className="mb-1 hidden px-3 text-[11px] font-bold tracking-[0.12em] text-white/45 uppercase xl:block">{g.label}</p>
              <div className="mx-auto mb-2 h-px w-8 bg-white/10 xl:hidden" aria-hidden="true" />
              <ul className="space-y-0.5">
                {g.items.map((n) => (
                  <li key={n.to}>
                    <SideLink {...n} badge={badgeFor(n.to)} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="shrink-0 border-t border-white/10 p-2 xl:p-3">
          {data && <CafeStatus open={!!open} compact />}
          <div className="mt-2 flex items-center gap-2">
            <Avatar profile={profile} />
            <span className="hidden min-w-0 flex-1 leading-tight xl:block">
              <span className="block truncate text-sm font-bold">{profile.display_name}</span>
              <span className="block text-xs text-white/60">{owner ? 'Owner' : 'Kitchen'}</span>
            </span>
            <button
              type="button"
              className="hidden size-9 shrink-0 place-items-center rounded-lg text-white/75 hover:bg-white/10 hover:text-white xl:grid"
              aria-label="Sign out"
              title="Sign out"
              disabled={signingOut}
              onClick={doSignOut}
            >
              <IconLogOut size={18} />
            </button>
          </div>
          <button
            type="button"
            className="mt-2 grid size-12 place-items-center rounded-lg text-white/75 hover:bg-white/10 hover:text-white xl:hidden"
            aria-label="Sign out"
            title="Sign out"
            disabled={signingOut}
            onClick={doSignOut}
          >
            <IconLogOut size={18} />
          </button>
        </div>
      </aside>

      {/* Top bar (phone) */}
      <header className="no-print sticky top-0 z-30 flex h-14 items-center gap-3 bg-ink px-4 text-white md:hidden">
        <Wordmark onDark className="text-[14px]" />
        <div className="ml-auto flex items-center gap-2">
          {data && <CafeStatus open={!!open} />}
          <button
            type="button"
            className="grid size-10 place-items-center rounded-full hover:bg-white/10"
            aria-label="Sign out"
            title="Sign out"
            disabled={signingOut}
            onClick={doSignOut}
          >
            <IconLogOut size={18} />
          </button>
        </div>
      </header>

      <div className="md:pl-16 xl:pl-60">
        <Outlet />
      </div>

      {/* Bottom tabs (phone) */}
      <nav aria-label="Staff" className="no-print fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden">
        <ul className="flex">
          {tabs.map((n) => (
            <li key={n.to} className="flex-1">
              <TabLink {...n} badge={badgeFor(n.to)} />
            </li>
          ))}
          {owner && (
            <li className="flex-1">
              <button
                type="button"
                onClick={() => setMoreOpen(true)}
                aria-haspopup="dialog"
                className={`relative flex min-h-14 w-full flex-col items-center justify-center gap-0.5 text-[11px] font-bold ${moreActive ? 'text-ink' : 'text-muted'}`}
              >
                {moreActive && <span className="absolute inset-x-5 top-0 h-[3px] rounded-b bg-brand" aria-hidden="true" />}
                <IconMore size={20} />
                More
              </button>
            </li>
          )}
        </ul>
      </nav>

      {owner && (
        <Dialog open={moreOpen} onClose={() => setMoreOpen(false)} title="More">
          <nav aria-label="More pages" className="p-2 pb-4">
            {groups.map((g) => {
              const items = g.items.filter((i) => !tabs.includes(i))
              if (!items.length) return null
              return (
                <div key={g.label} className="mt-2">
                  <p className="px-3 py-1 text-[11px] font-bold tracking-[0.12em] text-muted uppercase">{g.label}</p>
                  {items.map((n) => (
                    <NavLink
                      key={n.to}
                      to={n.to}
                      end={n.end}
                      viewTransition
                      className={({ isActive }) =>
                        `flex min-h-12 items-center gap-3 rounded-lg px-3 font-semibold ${isActive ? 'bg-brand-soft text-ink' : 'hover:bg-sunken'}`
                      }
                    >
                      <n.icon size={19} />
                      <span className="flex-1">{n.label}</span>
                      {badgeFor(n.to) > 0 && <CountBadge n={badgeFor(n.to)} />}
                    </NavLink>
                  ))}
                </div>
              )
            })}
          </nav>
        </Dialog>
      )}
    </div>
  )
}

function SideLink({ to, label, icon: Icon, end, badge }: NavEntry & { badge: number }) {
  return (
    <NavLink
      to={to}
      end={end}
      viewTransition
      title={label}
      className={({ isActive }) =>
        `relative flex min-h-11 items-center justify-center gap-3 rounded-lg px-3 text-sm font-semibold transition-colors xl:justify-start ${
          isActive ? 'bg-white/10 text-white' : 'text-white/70 hover:bg-white/5 hover:text-white'
        }`
      }
    >
      {({ isActive }) => (
        <>
          {isActive && <span className="absolute inset-y-2 left-0 w-[3px] rounded-r bg-brand" aria-hidden="true" />}
          <Icon size={19} className={isActive ? 'text-brand' : ''} />
          <span className="sr-only xl:not-sr-only xl:flex-1">{label}</span>
          {badge > 0 && (
            <span className="absolute top-1.5 right-1.5 xl:static">
              <CountBadge n={badge} />
            </span>
          )}
        </>
      )}
    </NavLink>
  )
}

function TabLink({ to, label, icon: Icon, end, badge }: NavEntry & { badge: number }) {
  return (
    <NavLink
      to={to}
      end={end}
      viewTransition
      className={({ isActive }) =>
        `relative flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-bold ${isActive ? 'text-ink' : 'text-muted'}`
      }
    >
      {({ isActive }) => (
        <>
          {isActive && <span className="absolute inset-x-5 top-0 h-[3px] rounded-b bg-brand" aria-hidden="true" />}
          <span className="relative">
            <Icon size={20} />
            {badge > 0 && (
              <span className="absolute -top-1.5 -right-3">
                <CountBadge n={badge} />
              </span>
            )}
          </span>
          {label}
        </>
      )}
    </NavLink>
  )
}

function CountBadge({ n }: { n: number }) {
  return (
    <span className="inline-grid min-w-5 place-items-center rounded-full bg-[#b45309] px-1.5 text-[11px] leading-5 font-bold text-white">
      {n}
      <span className="sr-only"> low on stock</span>
    </span>
  )
}

function CafeStatus({ open, compact = false }: { open: boolean; compact?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold ${open ? 'bg-ready text-white' : 'bg-danger text-white'} ${
        compact ? 'w-full justify-center xl:w-auto xl:justify-start' : ''
      }`}
      title={open ? 'Taking orders' : 'Closed for orders'}
    >
      <span className="size-1.5 shrink-0 rounded-full bg-white" aria-hidden="true" />
      <span className={compact ? 'sr-only xl:not-sr-only' : ''}>{open ? 'Open' : 'Closed'}</span>
    </span>
  )
}

function Avatar({ profile }: { profile: StaffProfile }) {
  const initials = profile.display_name
    .replace(/\(.*?\)/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')
  return (
    <span className="mx-auto grid size-9 shrink-0 place-items-center rounded-full bg-white/15 text-xs font-extrabold xl:mx-0" title={profile.display_name} aria-hidden="true">
      {initials || '?'}
    </span>
  )
}
