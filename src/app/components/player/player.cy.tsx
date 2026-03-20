import { usePlayerStore } from '@/store/player.store'
import { ISong } from '@/types/responses/song'
import { Player } from './player'

describe('Player Component', () => {
  beforeEach(() => {
    cy.mockCoverArt()
    cy.mockSongStream()
    const oversamplingActions =
      usePlayerStore.getState().settings.oversampling.actions
    oversamplingActions.setEnabled(false)
    oversamplingActions.setPresetId('poly-sinc-mp')
    oversamplingActions.setTargetRatePolicy('integer-family-max')
    oversamplingActions.setEnginePreference('auto')
    oversamplingActions.setOutputApi('wasapi-exclusive')
    oversamplingActions.setCapability({
      supportedOutputApis: ['wasapi-exclusive'],
      availableEngines: ['cpu'],
      maxTapCountByEngine: {
        cpu: 65536,
      },
    })
  })

  it('should mount the player and interact with it', () => {
    cy.fixture('songs/random').then((songs: ISong[]) => {
      usePlayerStore.getState().actions.setSongList(songs, 0)
      usePlayerStore.getState().actions.setPlayingState(false)

      cy.mount(<Player />)

      cy.getByTestId('player-button-play').as('playButton')
      cy.get('@playButton').should('be.visible')

      cy.getByTestId<HTMLAudioElement>('player-song-audio').then(($audio) => {
        const $el = $audio[0]

        cy.stub($el, 'load').as('loadStub')
        cy.stub($el, 'play').as('playStub')

        $el.removeAttribute('autoplay')
      })

      cy.getByTestId('player-current-time').should('have.text', '00:00')
      cy.getByTestId('player-duration-time').should('have.text', '03:27')

      cy.get('@playButton').click()
      cy.get('@playStub').should('have.been.called')

      cy.getByTestId('player-button-pause').as('pauseButton')
      cy.get('@pauseButton').should('be.visible')

      cy.get('@pauseButton').click()
      cy.getByTestId('player-button-play').should('be.visible')

      cy.getByTestId('player-button-shuffle')
        .should('be.visible')
        .and('not.have.attr', 'disabled')

      cy.getByTestId('player-button-prev')
        .should('be.visible')
        .and('have.attr', 'disabled', 'disabled')

      cy.getByTestId('player-button-next')
        .should('be.visible')
        .and('not.have.attr', 'disabled')

      cy.getByTestId('player-button-loop')
        .should('be.visible')
        .and('not.have.attr', 'disabled')
    })
  })

  it('should mount the player with a single song', () => {
    cy.fixture('songs/random').then((songs: ISong[]) => {
      usePlayerStore.getState().actions.setSongList([songs[1]], 0)
      usePlayerStore.getState().actions.setPlayingState(false)

      cy.mount(<Player />)

      cy.getByTestId('player-button-shuffle')
        .should('be.visible')
        .and('have.attr', 'disabled', 'disabled')

      cy.getByTestId('player-button-prev')
        .should('be.visible')
        .and('have.attr', 'disabled', 'disabled')

      cy.getByTestId('player-button-next')
        .should('be.visible')
        .and('have.attr', 'disabled', 'disabled')

      cy.getByTestId('player-button-loop')
        .should('be.visible')
        .and('not.have.attr', 'disabled')
    })
  })

  it('should mount the player with the last song on a list', () => {
    cy.fixture('songs/random').then((songs: ISong[]) => {
      usePlayerStore.getState().actions.setSongList(songs, songs.length - 1)
      usePlayerStore.getState().actions.setPlayingState(false)

      cy.mount(<Player />)

      cy.getByTestId('player-button-shuffle')
        .should('be.visible')
        .and('have.attr', 'disabled', 'disabled')

      cy.getByTestId('player-button-prev')
        .should('be.visible')
        .and('not.have.attr', 'disabled')

      cy.getByTestId('player-button-next')
        .should('be.visible')
        .and('have.attr', 'disabled', 'disabled')

      cy.getByTestId('player-button-loop')
        .should('be.visible')
        .and('not.have.attr', 'disabled')
    })
  })

  it('should mount the player and change the volume', () => {
    cy.fixture('songs/random').then((songs: ISong[]) => {
      usePlayerStore.getState().actions.setSongList([songs[1]], 0)
      usePlayerStore.getState().actions.setPlayingState(false)

      cy.mount(<Player />)

      cy.getByTestId<HTMLAudioElement>('player-song-audio').should(($audio) => {
        const $el = $audio[0]

        expect($el.volume).to.equal(1)
      })

      cy.getByTestId('player-volume-slider').click()

      cy.getByTestId<HTMLAudioElement>('player-song-audio').should(($audio) => {
        const $el = $audio[0]

        expect($el.volume).to.equal(0.5)
      })

      cy.getByTestId('player-volume-slider').click(20, 4)

      cy.getByTestId<HTMLAudioElement>('player-song-audio').should(($audio) => {
        const $el = $audio[0]

        expect($el.volume).to.equal(0.16)
      })
    })
  })

  it('should mount the player and toggle the shuffle button', () => {
    cy.fixture('songs/random').then((songs: ISong[]) => {
      usePlayerStore.getState().actions.setSongList(songs, 0)
      usePlayerStore.getState().actions.setPlayingState(false)

      cy.mount(<Player />)

      cy.getByTestId('player-button-shuffle')
        .as('shuffleButton')
        .should('be.visible')
        .and('not.have.class', 'player-button-active')

      cy.get('@shuffleButton').click()

      cy.get('@shuffleButton')
        .should('have.class', 'player-button-active')
        .then(() => {
          const songListAfterShuffle =
            usePlayerStore.getState().songlist.currentList

          cy.wrap(songListAfterShuffle).should('not.deep.equal', songs)
          cy.wrap(songListAfterShuffle).should('have.members', songs)
        })
    })
  })

  it('should mount the player and toggle the loop button', () => {
    cy.fixture('songs/random').then((songs: ISong[]) => {
      usePlayerStore.getState().actions.setSongList(songs, 0)
      usePlayerStore.getState().actions.setPlayingState(false)

      cy.mount(<Player />)

      cy.getByTestId('player-button-loop')
        .as('loopButton')
        .should('be.visible')
        .and('not.have.class', 'player-button-active')

      cy.getByTestId<HTMLAudioElement>('player-song-audio').then(($audio) => {
        const $el = $audio[0]

        expect($el.loop, 'Loop state should be false').to.equal(false)
      })

      cy.get('@loopButton').click()

      cy.get('@loopButton').should('have.class', 'player-button-active')

      cy.getByTestId<HTMLAudioElement>('player-song-audio').then(($audio) => {
        const $el = $audio[0]

        expect($el.loop, 'Loop state should be false on loop all').to.equal(
          false,
        )
      })

      cy.get('@loopButton').click()

      cy.getByTestId<HTMLAudioElement>('player-song-audio').then(($audio) => {
        const $el = $audio[0]

        expect($el.loop, 'Loop state should be true on loop one').to.equal(
          true,
        )
      })
    })
  })

  it('should open the signal path popover', () => {
    cy.fixture('songs/random').then((songs: ISong[]) => {
      usePlayerStore.getState().actions.setSongList(songs, 0)
      usePlayerStore.getState().actions.setPlayingState(false)
      const oversamplingActions =
        usePlayerStore.getState().settings.oversampling.actions
      oversamplingActions.setEnabled(false)
      oversamplingActions.setOutputApi('wasapi-exclusive')

      cy.mount(<Player />)

      cy.getByTestId('player-button-signal-path')
        .should('be.visible')
        .click()

      cy.getByTestId('player-signal-path-popover').should('be.visible')
      cy.getByTestId('player-signal-path-quality').should(
        'contain.text',
        'Lossy',
      )
      cy.getByTestId('player-signal-stage-source').should('be.visible')
      cy.getByTestId('player-signal-stage-source-value').should(
        'contain.text',
        'Navidrome',
      )
      cy.getByTestId('player-signal-stage-dsp-value').should(
        'contain.text',
        'Disabled',
      )
      cy.getByTestId('player-signal-stage-output').should('be.visible')
      cy.getByTestId('player-signal-stage-output-value').should(
        'contain.text',
        'System Shared',
      )
    })
  })

  it('should show enhanced quality when oversampling is enabled', () => {
    cy.fixture('songs/random').then((songs: ISong[]) => {
      usePlayerStore.getState().actions.setSongList(songs, 0)
      usePlayerStore.getState().actions.setPlayingState(false)
      const oversamplingActions =
        usePlayerStore.getState().settings.oversampling.actions
      oversamplingActions.setCapability({
        supportedOutputApis: ['wasapi-exclusive'],
        availableEngines: ['cpu'],
        maxTapCountByEngine: {
          cpu: 65536,
        },
      })
      oversamplingActions.setOutputApi('wasapi-exclusive')
      oversamplingActions.setPresetId('poly-sinc-mp')
      oversamplingActions.setEnginePreference('auto')
      oversamplingActions.setTargetRatePolicy('integer-family-max')
      oversamplingActions.setEnabled(true)

      cy.mount(<Player />)

      cy.getByTestId('player-button-signal-path')
        .should('be.visible')
        .click()

      cy.getByTestId('player-signal-path-quality').should(
        'contain.text',
        'Enhanced',
      )
      cy.getByTestId('player-signal-stage-dsp-value').should(
        'contain.text',
        'Oversampling',
      )
    })
  })

  it('should mount the player and change the progress slider', () => {
    cy.intercept('/rest/scrobble**', { statusCode: 200 }).as('scrobbleRequest')

    cy.fixture('songs/random').then((songs: ISong[]) => {
      usePlayerStore.getState().actions.setSongList(songs, 0)
      usePlayerStore.getState().actions.setPlayingState(false)
      usePlayerStore.getState().actions.setProgress(207 / 2)

      cy.mount(<Player />)

      cy.getByTestId('player-current-time').should('have.text', '01:43')
      cy.getByTestId('player-duration-time').should('have.text', '03:27')

      cy.wait('@scrobbleRequest').then((interception) => {
        expect(interception.request.method, 'Request method').to.equal('GET')
        expect(interception.response?.statusCode, 'Status code').to.equal(200)
      })
    })
  })

  it('should mount the player and like the song', () => {
    cy.intercept('/rest/star**', { statusCode: 200 }).as('starRequest')

    cy.fixture('songs/random').then((songs: ISong[]) => {
      usePlayerStore.getState().actions.setSongList(songs, 0)
      usePlayerStore.getState().actions.setPlayingState(false)

      cy.mount(<Player />)

      cy.getByTestId('player-like-icon')
        .should('be.visible')
        .and('not.have.class', 'text-red-500')
        .and('not.have.class', 'fill-red-500')

      cy.getByTestId('player-like-button').click()

      cy.wait('@starRequest').then((interception) => {
        expect(interception.request.method, 'Request method').to.equal('GET')
        expect(interception.response?.statusCode, 'Status code').to.equal(200)
      })

      cy.getByTestId('player-like-icon')
        .should('be.visible')
        .and('have.class', 'text-red-500')
        .and('have.class', 'fill-red-500')
    })
  })

  it('should move forward and backward through the queue', () => {
    cy.fixture('songs/random').then((songs: ISong[]) => {
      usePlayerStore.getState().actions.setSongList(songs, 0)
      usePlayerStore.getState().actions.setPlayingState(false)

      cy.mount(<Player />)

      cy.getByTestId('track-title')
        .eq(1)
        .should('be.visible')
        .and('have.text', songs[0].title)

      cy.getByTestId('player-button-next').click()

      cy.getByTestId('track-title')
        .eq(1)
        .should('be.visible')
        .and('have.text', songs[1].title)

      cy.then(() => {
        expect(usePlayerStore.getState().songlist.currentSongIndex).to.equal(1)
      })

      cy.getByTestId('player-button-prev').click()

      cy.getByTestId('track-title')
        .eq(1)
        .should('be.visible')
        .and('have.text', songs[0].title)

      cy.then(() => {
        expect(usePlayerStore.getState().songlist.currentSongIndex).to.equal(0)
      })
    })
  })
})
