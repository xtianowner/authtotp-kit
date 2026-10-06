import { lazy, Suspense } from 'react'
import AuthGate from './AuthGate.jsx'

// /vault: the login gate is in this chunk; the vault's inner pages (Dashboard and everything under it) are a
// separate chunk, so the signed-out first screen never downloads them (炫技验收 §12 首屏体积).
const loadDashboard = () => import('./Dashboard.jsx')
const Dashboard = lazy(loadDashboard)

// Probably signed in (sign-in sets the readable authtotp_csrf cookie, sign-out deletes it): fetch the vault chunk
// alongside the status request instead of after it. Signed out: AuthGate starts the fetch the moment the sign-in
// request succeeds. A wrong guess only costs (or saves) one chunk download; the status request decides what shows.
if (typeof document !== 'undefined' && /(?:^|;\s*)authtotp_csrf=/.test(document.cookie)) loadDashboard()

function VaultLoading() {
  return <div className="grid min-h-screen place-items-center"><div className="loader" aria-label="正在载入" /></div>
}

export default function VaultRoute() {
  return (
    <AuthGate onUnlockStart={loadDashboard}>
      <Suspense fallback={<VaultLoading />}>
        <Dashboard />
      </Suspense>
    </AuthGate>
  )
}
