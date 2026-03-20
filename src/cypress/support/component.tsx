/* eslint-disable @typescript-eslint/no-namespace */

import './commands'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { mount } from 'cypress/react'
import { MemoryRouter } from 'react-router-dom'
import { useAppStore } from '../../store/app.store'
import { AuthType } from '../../types/serverConfig'
import 'cypress-real-events'
import '../../index.css'
import '../../themes.css'
import '../../fonts.css'
import '../../i18n'

const queryClient = new QueryClient()

useAppStore.setState((state) => ({
  ...state,
  data: {
    // fix cy.intercept that wasn't intercepting requests without a base URL
    url: 'http://localhost:5173',
    // set a default authType to avoid errors
    authType: AuthType.TOKEN,
  },
}))

Cypress.Commands.add('mount', (component, options = {}) => {
  const { routerProps = { initialEntries: ['/'] }, ...mountOptions } = options

  const wrapped = (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter {...routerProps}>{component}</MemoryRouter>
    </QueryClientProvider>
  )

  return mount(wrapped, mountOptions)
})
