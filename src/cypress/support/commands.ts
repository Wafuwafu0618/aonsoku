/// <reference types="cypress" />
import i18n from '../../i18n'

Cypress.Commands.add('getByTestId', (query, options) => {
  return cy.get(`[data-testid="${query}"]`, options || undefined)
})

Cypress.Commands.add('mockCoverArt', () => {
  cy.intercept('/rest/getCoverArt**', { fixture: 'coverArt.jpeg' })
})

Cypress.Commands.add('mockSongStream', () => {
  cy.intercept('/rest/stream**', {
    fixture: 'song.mp3,null',
    headers: { 'Content-Type': 'audio/mpeg' },
  })
})

Cypress.Commands.add('changeLang', (lang) => {
  i18n.changeLanguage(lang)
})

Cypress.Commands.add(
  'findByTestId',
  { prevSubject: true },
  (subject, testId, options) => {
    return cy
      .wrap(subject)
      .find(`[data-testid="${testId}"]`, options || undefined)
  },
)
