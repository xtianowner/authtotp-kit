import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MotionConfig } from 'motion/react'
import { LocaleProvider } from './i18n/LocaleProvider.jsx'
import App from './App.jsx'
import './styles/global.js'

// MotionConfig reducedMotion="user" → 所有 motion 组件自动遵守 prefers-reduced-motion（转场/位移）。
// 注意：rAF 驱动的无限动画（如 ShinyText）仍需组件内 useReducedMotion 兜底。
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <LocaleProvider>
        <App />
      </LocaleProvider>
    </MotionConfig>
  </StrictMode>,
)
