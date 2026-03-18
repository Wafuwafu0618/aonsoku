import { defineConfig } from 'cypress'

export default defineConfig({
  component: {
    specPattern: 'src/**/*.cy.{ts,tsx}',
    supportFile: 'cypress/support/component.tsx',
    indexHtmlFile: 'cypress/support/component-index.html',
    viewportWidth: 1920,
    viewportHeight: 1080,
    devServer: {
      framework: 'react',
      bundler: 'vite',
    },
  },
})
