import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// UI fonts, self-hosted (not Google Fonts) so the app looks the same offline.
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-sans/700.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/600.css'
import './index.css'
// Attaches the install-prompt listener before anything renders (see pwa.ts).
import './lib/pwa'
import { forgetRetiredBetterScan, startServiceWorker } from './lib/serviceWorker'
import App from './App.tsx'

startServiceWorker()
forgetRetiredBetterScan()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
