import { lazy, Suspense } from 'react'
import { ToastProvider } from './components/ui/Toast.jsx'

// Route-level code splitting (炫技验收 §12 首屏体积): each entry downloads only its own page. The display-layer pages
// (/, signed-out /vault, /code, 404) are dark showcase pages; the vault's inner pages load on demand inside
// VaultRoute, and the public home's WebGL scene loads on demand inside PublicTotp.
const PublicTotp = lazy(() => import('./components/PublicTotp.jsx'))
const VaultRoute = lazy(() => import('./components/VaultRoute.jsx'))
// Colleague code page: link params live in the URL fragment; no vault entry points, no /api/* calls.
const CodePage = lazy(() => import('./components/CodePage.jsx'))
const NotFound = lazy(() => import('./components/NotFound.jsx'))

function routePage() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/'
  if (path === '/') return <PublicTotp />
  if (path === '/vault') return <VaultRoute />
  if (path === '/code') return <CodePage />
  return <NotFound />
}

export default function App() {
  return (
    <ToastProvider>
      {/* The page colour comes from <body> (dark-only tokens, color-scheme meta for the frame before the CSS), so
          the brief wait for a route chunk shows the right background and nothing else. */}
      <Suspense fallback={<div className="min-h-screen" />}>
        {routePage()}
      </Suspense>
    </ToastProvider>
  )
}
