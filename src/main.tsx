import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { registerServiceWorker } from './lib/push'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Notifications and the offline page (production builds only).
if (document.readyState === 'complete') void registerServiceWorker()
else window.addEventListener('load', () => void registerServiceWorker(), { once: true })
