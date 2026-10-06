import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MotionConfig } from 'motion/react'
import { LocaleProvider } from './i18n/LocaleProvider.jsx'
import { ToastProvider } from './components/ui/Toast.jsx'
import PublicTotp from './components/PublicTotp.jsx'
import './styles/global.js'

// Standalone public tool (npm run build:public → dist-public/): only PublicTotp and its providers, never the
// vault, callers, audit or login code. The 私有保险库 entry points appear only when VITE_VAULT_URL is set at
// build time (vite.public.config.js checks it is an absolute http(s) URL).
const vaultHref = import.meta.env.VITE_VAULT_URL || ''

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <LocaleProvider>
        <ToastProvider>
          <PublicTotp vaultHref={vaultHref} />
        </ToastProvider>
      </LocaleProvider>
    </MotionConfig>
  </StrictMode>,
)
