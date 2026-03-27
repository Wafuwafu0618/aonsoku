import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import 'react-lazy-load-image-component/src/effects/opacity.css'
import 'react-toastify/dist/ReactToastify.css'
import '@/fonts.css'
import '@/themes.css'
import '@/index.css'

import '@/i18n'

import App from '@/App'

import { queryClient } from '@/lib/queryClient'
import { initializeRemoteLibraryHandler } from './remote-library-handler'
import { blockFeatures } from '@/utils/browser'

blockFeatures()

if (
  typeof window !== 'undefined' &&
  window.api?.remoteLibraryRequestListener &&
  window.api?.sendRemoteLibraryResponse
) {
  initializeRemoteLibraryHandler()
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
