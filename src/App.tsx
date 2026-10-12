import { lazy, Suspense, useState } from 'react'
import { BrowserRouter, HashRouter, MemoryRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { shouldShowIntro, Splash } from './components/Splash'
import { ToastProvider, useClearToastsOn } from './components/ui'
import { NotFound } from './pages/NotFound'
import { RequireStaff } from './pages/staff/RequireStaff'
import { Spinner } from './components/ui'
import { CartPage } from './pages/student/CartPage'
import { MenuPage } from './pages/student/MenuPage'
import { MyOrdersPage } from './pages/student/MyOrdersPage'
import { OrderPage } from './pages/student/OrderPage'
import { TableEntry } from './pages/student/TableEntry'
import { LangProvider } from './i18n'
import { CartProvider } from './state/cart'
import { PublicDataProvider, usePublicData } from './state/publicData'
import { StaffSessionProvider } from './state/staffSession'

// The owner console and kitchen screen load separately, so students only download the menu.
const AuditLogPage = lazy(() => import('./pages/staff/AuditLogPage').then((m) => ({ default: m.AuditLogPage })))
const DayClosePage = lazy(() => import('./pages/staff/DayClosePage').then((m) => ({ default: m.DayClosePage })))
const FeedbackPage = lazy(() => import('./pages/staff/FeedbackPage').then((m) => ({ default: m.FeedbackPage })))
const InsightsPage = lazy(() => import('./pages/staff/InsightsPage').then((m) => ({ default: m.InsightsPage })))
const OffersPage = lazy(() => import('./pages/staff/OffersPage').then((m) => ({ default: m.OffersPage })))
const ExpensesPage = lazy(() => import('./pages/staff/ExpensesPage').then((m) => ({ default: m.ExpensesPage })))
const InventoryPage = lazy(() => import('./pages/staff/InventoryPage').then((m) => ({ default: m.InventoryPage })))
const LoginPage = lazy(() => import('./pages/staff/LoginPage').then((m) => ({ default: m.LoginPage })))
const MenuManager = lazy(() => import('./pages/staff/MenuManager').then((m) => ({ default: m.MenuManager })))
const OrdersBoard = lazy(() => import('./pages/staff/OrdersBoard').then((m) => ({ default: m.OrdersBoard })))
const PrintQrPage = lazy(() => import('./pages/staff/PrintQrPage').then((m) => ({ default: m.PrintQrPage })))
const ProfitLossPage = lazy(() => import('./pages/staff/ProfitLossPage').then((m) => ({ default: m.ProfitLossPage })))
const ReportsPage = lazy(() => import('./pages/staff/ReportsPage').then((m) => ({ default: m.ReportsPage })))
const SettingsPage = lazy(() => import('./pages/staff/SettingsPage').then((m) => ({ default: m.SettingsPage })))
const StaffLayout = lazy(() => import('./pages/staff/StaffLayout').then((m) => ({ default: m.StaffLayout })))
const KitchenScreen = lazy(() => import('./pages/KitchenScreen').then((m) => ({ default: m.KitchenScreen })))

export function AppRoutes() {
  const location = useLocation()
  useClearToastsOn(location.pathname)
  return (
    <Suspense fallback={<div className="grid min-h-dvh place-items-center"><Spinner label="Loading" /></div>}>
    <Routes>
      <Route path="/" element={<MenuPage />} />
      <Route path="/t/:label" element={<TableEntry />} />
      <Route path="/cart" element={<CartPage />} />
      <Route path="/order/:id" element={<OrderPage />} />
      <Route path="/orders" element={<MyOrdersPage />} />
      <Route path="/kitchen/:key" element={<KitchenScreen />} />

      <Route path="/staff/login" element={<LoginPage />} />
      <Route path="/staff/print-qr" element={<RequireStaff ownerOnly><PrintQrPage /></RequireStaff>} />
      <Route path="/staff" element={<RequireStaff><StaffLayout /></RequireStaff>}>
        <Route index element={<OrdersBoard />} />
        <Route path="menu" element={<MenuManager />} />
        <Route path="inventory" element={<InventoryPage />} />
        <Route path="reports" element={<RequireStaff ownerOnly><ReportsPage /></RequireStaff>} />
        <Route path="profit" element={<RequireStaff ownerOnly><ProfitLossPage /></RequireStaff>} />
        <Route path="expenses" element={<RequireStaff ownerOnly><ExpensesPage /></RequireStaff>} />
        <Route path="offers" element={<RequireStaff ownerOnly><OffersPage /></RequireStaff>} />
        <Route path="close-day" element={<RequireStaff ownerOnly><DayClosePage /></RequireStaff>} />
        <Route path="insights" element={<RequireStaff ownerOnly><InsightsPage /></RequireStaff>} />
        <Route path="feedback" element={<RequireStaff ownerOnly><FeedbackPage /></RequireStaff>} />
        <Route path="audit" element={<RequireStaff ownerOnly><AuditLogPage /></RequireStaff>} />
        <Route path="settings" element={<RequireStaff ownerOnly><SettingsPage /></RequireStaff>} />
        <Route path="*" element={<Navigate to="/staff" replace />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
    </Suspense>
  )
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <LangProvider>
      <ToastProvider>
        <PublicDataProvider>
          <StaffSessionProvider>
            <CartProvider>{children}</CartProvider>
          </StaffSessionProvider>
        </PublicDataProvider>
      </ToastProvider>
    </LangProvider>
  )
}

// Hash/memory routing is only for static previews that can't rewrite deep links to index.html.
const Router = import.meta.env.VITE_ROUTER === 'hash' ? HashRouter : import.meta.env.VITE_ROUTER === 'memory' ? MemoryRouter : BrowserRouter

/** Brand intro on the first student visit of a session; doubles as the menu loader. */
function Intro() {
  const location = useLocation()
  const [show, setShow] = useState(() => shouldShowIntro(location.pathname))
  const { data, error } = usePublicData()
  if (!show) return null
  return <Splash ready={!!data || !!error} onDone={() => setShow(false)} />
}

export default function App() {
  return (
    <Router>
      <Providers>
        <AppRoutes />
        <Intro />
      </Providers>
    </Router>
  )
}
