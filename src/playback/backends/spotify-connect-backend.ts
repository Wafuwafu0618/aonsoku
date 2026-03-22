import {
  spotifyConnectInitialize,
  spotifyConnectListDevices,
  spotifyConnectPlayUri,
  spotifyConnectSetActiveDevice,
  spotifyConnectStatus,
} from '@/platform'
import {
  PlaybackBackend,
  PlaybackBackendCapabilities,
  PlaybackSubscription,
  PlaybackUnsubscribe,
} from '@/playback/backend'
import {
  PlaybackEvent,
  PlaybackEventType,
  PlaybackLoadRequest,
  PlaybackSnapshot,
  PlaybackStatus,
} from '@/playback/session-types'
import {
  getSpotifyAccessTokenForPlaybackControl,
  spotifyGetPlaybackState,
  normalizeSpotifyPlaybackSource,
  spotifyPausePlaybackOnDevice,
  spotifyResumePlaybackOnDevice,
  spotifySeekPlayback,
} from '@/service/spotify'
import { logger } from '@/utils/logger'

const STATUS_POLL_INTERVAL_MS = 1000

const capabilities: PlaybackBackendCapabilities = {
  canSeek: true,
  canSetVolume: false,
  emitsTimeUpdates: true,
}

function normalizeTime(value: number): number {
  if (!Number.isFinite(value) || Number.isNaN(value)) return 0
  if (value < 0) return 0

  return value
}

function normalizeVolume(value: number): number {
  if (!Number.isFinite(value) || Number.isNaN(value)) return 1
  if (value < 0) return 0
  if (value > 1) return 1

  return value
}

export class SpotifyConnectPlaybackBackend implements PlaybackBackend {
  readonly id = 'spotify-connect' as const
  readonly capabilities = capabilities

  private listeners = new Set<PlaybackSubscription>()
  private status: PlaybackStatus = 'idle'

  private isPlaying = false
  private currentTimeSeconds = 0
  private durationSeconds = 0
  private volume = 1
  private loop = false
  private playbackRate = 1
  private errorMessage: string | undefined
  private currentUri: string | null = null
  private activeDeviceId: string | null = null
  private hasLoadedMetadata = false

  private pollTimer: ReturnType<typeof setInterval> | null = null
  private disposed = false

  private emit(type: PlaybackEventType): void {
    const event: PlaybackEvent = {
      type,
      snapshot: this.getSnapshot(),
    }

    this.listeners.forEach((listener) => listener(event))
  }

  private setError(error: unknown): void {
    const nextMessage = error instanceof Error ? error.message : String(error)
    const shouldEmit =
      this.status !== 'error' || this.errorMessage !== nextMessage

    this.status = 'error'
    this.errorMessage = nextMessage

    if (shouldEmit) {
      this.emit('error')
    }
  }

  private async syncStatusFromSidecar(): Promise<void> {
    const prevIsPlaying = this.isPlaying

    try {
      const playbackState = await spotifyGetPlaybackState()
      if (!playbackState) {
        this.errorMessage = undefined
        this.currentTimeSeconds = 0
        this.durationSeconds = 0
        this.isPlaying = false

        if (prevIsPlaying) {
          this.status = 'paused'
          this.emit('pause')
        }
        this.emit('timeupdate')
        return
      }

      this.errorMessage = undefined
      this.currentTimeSeconds = normalizeTime(playbackState.progressSeconds)
      this.durationSeconds = normalizeTime(playbackState.durationSeconds)
      this.volume = normalizeVolume(playbackState.volume)
      this.isPlaying = Boolean(playbackState.isPlaying)
      this.activeDeviceId = playbackState.activeDeviceId ?? null

      if (playbackState.activeTrack?.spotifyUri) {
        this.currentUri = playbackState.activeTrack.spotifyUri
      }

      if (this.durationSeconds > 0 && !this.hasLoadedMetadata) {
        this.hasLoadedMetadata = true
        this.emit('loadedmetadata')
      }

      if (prevIsPlaying !== this.isPlaying) {
        if (this.isPlaying) {
          this.status = 'playing'
          this.emit('play')
        } else if (
          this.durationSeconds > 0 &&
          this.currentTimeSeconds >= this.durationSeconds - 1
        ) {
          this.status = 'ended'
          this.emit('ended')
        } else {
          this.status = 'paused'
          this.emit('pause')
        }
      } else if (this.isPlaying) {
        this.status = 'playing'
      } else if (this.status === 'loading') {
        this.status = 'ready'
      }

      this.emit('timeupdate')
    } catch (error) {
      logger.warn('Failed to sync spotify connect status', { error })
      this.setError(error)
    }
  }

  private startStatusPolling(): void {
    if (this.pollTimer || this.disposed) return

    this.pollTimer = setInterval(() => {
      void this.syncStatusFromSidecar()
    }, STATUS_POLL_INTERVAL_MS)
  }

  private stopStatusPolling(): void {
    if (!this.pollTimer) return

    clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  private async ensureSidecarInitialized(): Promise<void> {
    let accessToken: string
    try {
      accessToken = await getSpotifyAccessTokenForPlaybackControl()
    } catch (error) {
      const statusResult = await spotifyConnectStatus().catch(() => null)
      if (statusResult?.ok && statusResult.initialized) {
        logger.warn(
          'Using existing spotify sidecar session because access token refresh failed.',
          { error },
        )
        return
      }
      throw error
    }

    const initResult = await spotifyConnectInitialize({
      accessToken,
    })

    if (!initResult.ok) {
      throw new Error(initResult.message ?? 'Failed to initialize Spotify Connect sidecar.')
    }
  }

  private async ensurePlayableDeviceId(): Promise<string | undefined> {
    if (this.activeDeviceId) {
      return this.activeDeviceId
    }

    const statusResult = await spotifyConnectStatus()
    if (statusResult.ok && statusResult.activeDeviceId) {
      this.activeDeviceId = statusResult.activeDeviceId
      return this.activeDeviceId
    }

    const devicesResult = await spotifyConnectListDevices()
    if (!devicesResult.ok) {
      logger.warn('Failed to list spotify devices before playback', {
        error: devicesResult.error,
      })
      return undefined
    }

    const candidateDeviceId =
      devicesResult.activeDeviceId ??
      devicesResult.devices.find((device) => device.isActive)?.id ??
      devicesResult.devices.find((device) => device.isRestricted !== true)?.id ??
      devicesResult.devices[0]?.id

    if (!candidateDeviceId) {
      return undefined
    }

    const setDeviceResult = await spotifyConnectSetActiveDevice({
      deviceId: candidateDeviceId,
      transferPlayback: true,
    })
    if (!setDeviceResult.ok) {
      logger.warn('Failed to set active spotify device before playback', {
        error: setDeviceResult.error,
        deviceId: candidateDeviceId,
      })
    }

    this.activeDeviceId = candidateDeviceId
    return candidateDeviceId
  }

  async load(request: PlaybackLoadRequest): Promise<void> {
    const spotifyUri = normalizeSpotifyPlaybackSource(request.src)

    this.status = 'loading'
    this.errorMessage = undefined
    this.currentUri = spotifyUri
    this.loop = Boolean(request.loop)
    this.hasLoadedMetadata = false

    await this.ensureSidecarInitialized()
    const deviceId = await this.ensurePlayableDeviceId()

    const result = await spotifyConnectPlayUri({
      spotifyUri,
      deviceId,
      startAtSeconds:
        typeof request.startAtSeconds === 'number'
          ? Math.floor(normalizeTime(request.startAtSeconds))
          : undefined,
    })

    if (!result.ok) {
      throw new Error(result.error?.message ?? 'Failed to request Spotify URI playback.')
    }

    this.startStatusPolling()
    await this.syncStatusFromSidecar()

    if (request.autoplay === false) {
      try {
        await spotifyPausePlaybackOnDevice(this.activeDeviceId ?? undefined)
        this.isPlaying = false
        this.status = 'paused'
        this.emit('pause')
      } catch (error) {
        logger.warn('Failed to pause spotify playback after load', { error })
      }
    }
  }

  async play(): Promise<void> {
    this.errorMessage = undefined

    try {
      await spotifyResumePlaybackOnDevice(this.activeDeviceId ?? undefined)
    } catch (error) {
      if (!this.currentUri) {
        throw error
      }

      const result = await spotifyConnectPlayUri({
        spotifyUri: this.currentUri,
        deviceId: this.activeDeviceId ?? undefined,
        startAtSeconds: Math.floor(this.currentTimeSeconds),
      })
      if (!result.ok) {
        throw new Error(result.error?.message ?? 'Failed to resume Spotify playback.')
      }
    }

    const wasPlaying = this.isPlaying
    this.isPlaying = true
    this.status = 'playing'
    this.startStatusPolling()

    if (!wasPlaying) {
      this.emit('play')
    }
  }

  pause(): void {
    void (async () => {
      try {
        await spotifyPausePlaybackOnDevice(this.activeDeviceId ?? undefined)
      } catch (error) {
        logger.warn('Failed to pause spotify playback', { error })
        this.setError(error)
        return
      }

      const wasPlaying = this.isPlaying
      this.isPlaying = false
      this.status = 'paused'

      if (wasPlaying) {
        this.emit('pause')
      }
    })()
  }

  seek(positionSeconds: number): void {
    if (!this.currentUri) return

    const nextPosition = Math.floor(normalizeTime(positionSeconds))
    this.currentTimeSeconds = nextPosition
    this.emit('timeupdate')

    void (async () => {
      try {
        await spotifySeekPlayback(nextPosition, this.activeDeviceId ?? undefined)
      } catch (seekError) {
        logger.warn('spotifySeekPlayback failed. Falling back to playUri seek.', {
          error: seekError,
        })
        const result = await spotifyConnectPlayUri({
          spotifyUri: this.currentUri,
          deviceId: this.activeDeviceId ?? undefined,
          startAtSeconds: nextPosition,
        })
        if (!result.ok) {
          throw new Error(result.error?.message ?? 'Failed to seek Spotify playback.')
        }
      }

      if (!this.isPlaying) {
        await spotifyPausePlaybackOnDevice(this.activeDeviceId ?? undefined)
      }
    })().catch((error) => {
      logger.warn('Failed to seek spotify playback', { error })
      this.setError(error)
    })
  }

  setVolume(_volume: number): void {
    // Spotify Connect volume is controlled by remote device/app.
  }

  getSnapshot(): PlaybackSnapshot {
    return {
      backendId: this.id,
      status: this.status,
      isPlaying: this.isPlaying,
      currentTimeSeconds: this.currentTimeSeconds,
      durationSeconds: this.durationSeconds,
      volume: this.volume,
      loop: this.loop,
      playbackRate: this.playbackRate,
      error: this.errorMessage,
    }
  }

  subscribe(listener: PlaybackSubscription): PlaybackUnsubscribe {
    this.listeners.add(listener)

    return () => {
      this.listeners.delete(listener)
    }
  }

  dispose(): void {
    this.disposed = true
    this.stopStatusPolling()
    this.listeners.clear()
    this.status = 'idle'
    this.isPlaying = false
    this.errorMessage = undefined
  }
}
