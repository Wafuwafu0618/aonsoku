import {
  IAonsokuAPI,
  NativeAudioCommandResult,
  NativeAudioErrorPayload,
  NativeAudioEvent,
  NativeAudioOutputMode,
} from '@/platform/contracts/desktop-contract'
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
import { logger } from '@/utils/logger'

const capabilities: PlaybackBackendCapabilities = {
  canSeek: true,
  canSetVolume: true,
  emitsTimeUpdates: true,
}

function clampVolume(volume: number): number {
  if (Number.isNaN(volume)) return 1
  if (volume < 0) return 0
  if (volume > 1) return 1

  return volume
}

function normalizeTime(value: number): number {
  if (!Number.isFinite(value) || Number.isNaN(value)) return 0

  return value
}

function readApi(): IAonsokuAPI | null {
  if (typeof window === 'undefined') return null

  const maybeApi = (window as Window & { api?: IAonsokuAPI }).api
  if (!maybeApi) return null

  return maybeApi
}

function toErrorPayload(
  error: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): NativeAudioErrorPayload {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'message' in error
  ) {
    const nativeError = error as {
      code?: unknown
      message?: unknown
      details?: unknown
    }

    if (
      typeof nativeError.code === 'string' &&
      typeof nativeError.message === 'string'
    ) {
      return {
        code: nativeError.code,
        message: nativeError.message,
        details:
          typeof nativeError.details === 'object' && nativeError.details !== null
            ? (nativeError.details as Record<string, unknown>)
            : undefined,
      }
    }
  }

  return {
    code: fallbackCode,
    message: fallbackMessage,
  }
}

function ensureResultOk(
  result: NativeAudioCommandResult,
  fallbackCode: string,
  fallbackMessage: string,
): void {
  if (result.ok) return

  throw result.error ?? {
    code: fallbackCode,
    message: fallbackMessage,
  }
}

export interface NativePlaybackBackendOptions {
  outputMode: NativeAudioOutputMode
}

export class NativePlaybackBackend implements PlaybackBackend {
  readonly id = 'native' as const
  readonly capabilities = capabilities

  private listeners = new Set<PlaybackSubscription>()
  private status: PlaybackStatus = 'idle'

  private currentTimeSeconds = 0
  private durationSeconds = 0
  private isPlaying = false
  private volume = 1
  private loop = false
  private playbackRate = 1
  private errorMessage: string | undefined

  private initialized = false
  private listenerAttached = false
  private disposed = false

  private outputMode: NativeAudioOutputMode

  constructor(options: NativePlaybackBackendOptions) {
    this.outputMode = options.outputMode
    this.attachEventListener()
  }

  private attachEventListener(): void {
    const api = readApi()
    if (!api) {
      this.status = 'error'
      this.errorMessage = 'Native audio API is not available.'
      return
    }

    api.nativeAudioEventListener((event) => {
      this.handleNativeEvent(event)
    })
    this.listenerAttached = true
  }

  private detachEventListener(): void {
    const api = readApi()
    if (!api || !this.listenerAttached) return

    api.removeNativeAudioEventListener()
    this.listenerAttached = false
  }

  private emit(type: PlaybackEventType): void {
    const event: PlaybackEvent = {
      type,
      snapshot: this.getSnapshot(),
    }

    this.listeners.forEach((listener) => listener(event))
  }

  private handleNativeEvent(event: NativeAudioEvent): void {
    if (this.disposed) return

    if (typeof event.currentTimeSeconds === 'number') {
      this.currentTimeSeconds = normalizeTime(event.currentTimeSeconds)
    }

    if (typeof event.durationSeconds === 'number') {
      this.durationSeconds = normalizeTime(event.durationSeconds)
    }

    if (event.type === 'ready') {
      if (this.status === 'idle' || this.status === 'loading') {
        this.status = 'ready'
      }
      return
    }

    if (event.type === 'deviceChanged') {
      logger.info('[NativePlaybackBackend] Device changed event received')
      return
    }

    if (event.type === 'loadedmetadata') {
      this.status = 'ready'
      this.emit('loadedmetadata')
      return
    }

    if (event.type === 'timeupdate') {
      this.emit('timeupdate')
      return
    }

    if (event.type === 'play') {
      this.status = 'playing'
      this.isPlaying = true
      this.emit('play')
      return
    }

    if (event.type === 'pause') {
      this.status = this.status === 'ended' ? 'ended' : 'paused'
      this.isPlaying = false
      this.emit('pause')
      return
    }

    if (event.type === 'ended') {
      this.status = 'ended'
      this.isPlaying = false
      this.emit('ended')
      return
    }

    if (event.type === 'error') {
      this.status = 'error'
      this.isPlaying = false
      this.errorMessage =
        event.error?.message ?? 'Native audio sidecar reported an error.'
      this.emit('error')
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return

    const api = readApi()
    if (!api) {
      throw {
        code: 'native-api-unavailable',
        message: 'Native audio API is not available.',
      }
    }

    const initializeResult = await api.nativeAudioInitialize()
    if (!initializeResult.ok) {
      throw {
        code: 'native-audio-initialize-failed',
        message:
          initializeResult.message ?? 'Failed to initialize native audio backend.',
      }
    }

    const setModeResult = await api.nativeAudioSetOutputMode(this.outputMode)
    ensureResultOk(
      setModeResult,
      'native-audio-set-output-mode-failed',
      `Failed to set native output mode: ${this.outputMode}`,
    )

    this.initialized = true
  }

  async setOutputMode(mode: NativeAudioOutputMode): Promise<void> {
    this.outputMode = mode

    if (!this.initialized) return

    const api = readApi()
    if (!api) {
      throw {
        code: 'native-api-unavailable',
        message: 'Native audio API is not available.',
      }
    }

    const setModeResult = await api.nativeAudioSetOutputMode(mode)
    ensureResultOk(
      setModeResult,
      'native-audio-set-output-mode-failed',
      `Failed to set native output mode: ${mode}`,
    )
  }

  async load(request: PlaybackLoadRequest): Promise<void> {
    const api = readApi()
    if (!api) {
      const error = {
        code: 'native-api-unavailable',
        message: 'Native audio API is not available.',
      }
      this.status = 'error'
      this.errorMessage = error.message
      this.emit('error')
      throw error
    }

    this.status = 'loading'
    this.errorMessage = undefined

    if (typeof request.loop === 'boolean') {
      this.loop = request.loop
    }
    if (typeof request.playbackRate === 'number') {
      this.playbackRate = request.playbackRate
    }
    if (typeof request.startAtSeconds === 'number') {
      this.currentTimeSeconds = normalizeTime(request.startAtSeconds)
    }

    try {
      await this.ensureInitialized()

      const result = await api.nativeAudioLoad(request)
      ensureResultOk(
        result,
        'native-audio-load-failed',
        'Failed to load native audio source.',
      )
    } catch (error) {
      const payload = toErrorPayload(
        error,
        'native-audio-load-failed',
        'Failed to load native audio source.',
      )
      this.status = 'error'
      this.errorMessage = payload.message
      this.emit('error')
      throw payload
    }
  }

  async play(): Promise<void> {
    const api = readApi()
    if (!api) {
      throw {
        code: 'native-api-unavailable',
        message: 'Native audio API is not available.',
      }
    }

    try {
      await this.ensureInitialized()
      const result = await api.nativeAudioPlay()
      ensureResultOk(
        result,
        'native-audio-play-failed',
        'Failed to start native audio playback.',
      )
    } catch (error) {
      const payload = toErrorPayload(
        error,
        'native-audio-play-failed',
        'Failed to start native audio playback.',
      )
      this.status = 'error'
      this.errorMessage = payload.message
      this.emit('error')
      throw payload
    }
  }

  pause(): void {
    const api = readApi()
    if (!api || this.disposed) return

    api
      .nativeAudioPause()
      .then((result) => {
        ensureResultOk(
          result,
          'native-audio-pause-failed',
          'Failed to pause native audio playback.',
        )
      })
      .catch((error) => {
        const payload = toErrorPayload(
          error,
          'native-audio-pause-failed',
          'Failed to pause native audio playback.',
        )
        this.status = 'error'
        this.errorMessage = payload.message
        this.emit('error')
      })
  }

  seek(positionSeconds: number): void {
    const api = readApi()
    if (!api || this.disposed) return

    const nextPositionSeconds = normalizeTime(positionSeconds)
    this.currentTimeSeconds = nextPositionSeconds

    api
      .nativeAudioSeek(nextPositionSeconds)
      .then((result) => {
        ensureResultOk(
          result,
          'native-audio-seek-failed',
          'Failed to seek native audio playback.',
        )
      })
      .catch((error) => {
        const payload = toErrorPayload(
          error,
          'native-audio-seek-failed',
          'Failed to seek native audio playback.',
        )
        this.status = 'error'
        this.errorMessage = payload.message
        this.emit('error')
      })
  }

  setVolume(volume: number): void {
    const api = readApi()
    if (!api || this.disposed) return

    const nextVolume = clampVolume(volume)
    this.volume = nextVolume

    api
      .nativeAudioSetVolume(nextVolume)
      .then((result) => {
        ensureResultOk(
          result,
          'native-audio-set-volume-failed',
          'Failed to set native audio volume.',
        )
      })
      .catch((error) => {
        const payload = toErrorPayload(
          error,
          'native-audio-set-volume-failed',
          'Failed to set native audio volume.',
        )
        this.status = 'error'
        this.errorMessage = payload.message
        this.emit('error')
      })
  }

  getSnapshot(): PlaybackSnapshot {
    return {
      backendId: this.id,
      status: this.status,
      isPlaying: this.isPlaying,
      currentTimeSeconds: normalizeTime(this.currentTimeSeconds),
      durationSeconds: normalizeTime(this.durationSeconds),
      volume: clampVolume(this.volume),
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
    if (this.disposed) return

    this.disposed = true
    this.detachEventListener()
    this.listeners.clear()
    this.status = 'idle'

    const api = readApi()
    if (!api) return

    api.nativeAudioDispose().catch((error) => {
      logger.error('[NativePlaybackBackend] dispose failed', error)
    })
  }
}


