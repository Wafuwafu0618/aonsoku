import {
  IAonsokuAPI,
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
import { PlaybackBackendId } from '@/domain/playback-backend'
import { logger } from '@/utils/logger'

const LOG_TAG = '[AppleMusicBackend]'
const APPLE_MUSIC_URI_PREFIX = 'apple-music://'

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
  return maybeApi ?? null
}

interface AppleMusicPlaybackBackendInput {
  outputMode: NativeAudioOutputMode
}

export class AppleMusicPlaybackBackend implements PlaybackBackend {
  readonly id = 'apple-music' as PlaybackBackendId
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

  private initialized = false
  private listenerAttached = false
  private disposed = false
  private currentAdamId: string | null = null
  private pendingLoad: Promise<void> | null = null
  private pendingPlay: Promise<void> | null = null
  private currentLoadedSrc: string | null = null
  private outputMode: NativeAudioOutputMode

  constructor(input: AppleMusicPlaybackBackendInput) {
    this.outputMode = input.outputMode
    this.attachEventListener()
  }

  private extractAdamId(source: string): string {
    if (!source.startsWith(APPLE_MUSIC_URI_PREFIX)) {
      throw new Error('Apple Music source must start with apple-music://')
    }

    const adamId = source.slice(APPLE_MUSIC_URI_PREFIX.length).trim()
    if (adamId.length === 0) {
      throw new Error('Apple Music source does not include adamId')
    }

    return adamId
  }

  private emit(type: PlaybackEventType): void {
    const event: PlaybackEvent = {
      type,
      snapshot: this.getSnapshot(),
    }
    this.listeners.forEach((listener) => listener(event))
  }

  private attachEventListener(): void {
    const api = readApi()
    if (!api) {
      this.status = 'error'
      this.errorMessage = 'Native audio API is not available.'
      return
    }

    api.nativeAudioEventListener((event: NativeAudioEvent) => {
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

  private handleNativeEvent(event: NativeAudioEvent): void {
    if (this.disposed) return

    if (typeof event.currentTimeSeconds === 'number') {
      this.currentTimeSeconds = normalizeTime(event.currentTimeSeconds)
    }
    if (typeof event.durationSeconds === 'number') {
      const nextDuration = normalizeTime(event.durationSeconds)
      // Keep known track duration when sidecar emits transient 0.
      if (nextDuration > 0 || this.durationSeconds <= 0) {
        this.durationSeconds = nextDuration
      }
    }

    if (event.type === 'ready') {
      if (this.status === 'idle' || this.status === 'loading') {
        this.status = 'ready'
      }
      return
    }
    if (event.type === 'deviceChanged') return
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
      throw { code: 'native-api-unavailable', message: 'Native audio API is not available.' }
    }

    const initResult = await api.nativeAudioInitialize()
    if (!initResult.ok) {
      throw {
        code: 'native-audio-initialize-failed',
        message: initResult.message ?? 'Failed to initialize native audio backend.',
      }
    }

    const modeResult = await api.nativeAudioSetOutputMode(this.outputMode)
    if (!modeResult.ok) {
      // Fallback to wasapi-shared if exclusive fails
      if (this.outputMode === 'wasapi-exclusive') {
        logger.warn(LOG_TAG, 'Exclusive mode unavailable, falling back to wasapi-shared')
        const fallback = await api.nativeAudioSetOutputMode('wasapi-shared')
        if (!fallback.ok) {
          throw { code: 'native-audio-set-output-mode-failed', message: 'Failed to set output mode.' }
        }
        this.outputMode = 'wasapi-shared'
      } else {
        throw { code: 'native-audio-set-output-mode-failed', message: 'Failed to set output mode.' }
      }
    }

    this.initialized = true
  }

  async load(request: PlaybackLoadRequest): Promise<void> {
    if (this.pendingLoad && this.currentLoadedSrc === request.src) {
      await this.pendingLoad
      return
    }

    const loadTask = this.loadInternal(request)
    this.pendingLoad = loadTask
    this.currentLoadedSrc = request.src

    try {
      await loadTask
    } finally {
      if (this.pendingLoad === loadTask) {
        this.pendingLoad = null
      }
    }
  }

  private async loadInternal(request: PlaybackLoadRequest): Promise<void> {
    const api = readApi()
    if (!api) {
      this.status = 'error'
      this.errorMessage = 'Native audio API is not available.'
      this.emit('error')
      throw { code: 'native-api-unavailable', message: this.errorMessage }
    }

    this.errorMessage = undefined
    this.status = 'loading'

    if (typeof request.loop === 'boolean') {
      this.loop = request.loop
    }
    if (typeof request.playbackRate === 'number') {
      this.playbackRate = request.playbackRate
    }

    try {
      // Step 1: Extract adamId from apple-music:// URI
      const adamId = this.extractAdamId(request.src)
      this.currentAdamId = adamId
      logger.info(LOG_TAG, `Resolving adamId: ${adamId}`)
      logger.info(LOG_TAG, `Load request: autoplay=${request.autoplay ? 'true' : 'false'}`)

      // Step 2: Call main process pipeline to fetch, decrypt, and create temp file
      const resolveResult = await api.appleMusicResolve(adamId)
      if (!resolveResult.ok || !resolveResult.tempFilePath) {
        const errorMsg = resolveResult.error?.message ?? 'Failed to resolve Apple Music track'
        throw { code: resolveResult.error?.code ?? 'apple-music-resolve-failed', message: errorMsg }
      }

      logger.info(LOG_TAG, `Resolved to temp file: ${resolveResult.tempFilePath}`)

      // Step 3: Use duration from the resolve result if available
      if (typeof resolveResult.durationSeconds === 'number') {
        this.durationSeconds = resolveResult.durationSeconds
      }

      // Step 4: Initialize native audio sidecar and load the decrypted temp file
      await this.ensureInitialized()

      const loadResult = await api.nativeAudioLoad({
        src: resolveResult.tempFilePath,
        autoplay: request.autoplay,
        loop: request.loop,
        startAtSeconds: request.startAtSeconds,
        playbackRate: request.playbackRate,
        durationSeconds: resolveResult.durationSeconds ?? request.durationSeconds,
        targetSampleRateHz: request.targetSampleRateHz,
        oversamplingFilterId: request.oversamplingFilterId,
        parametricEq: request.parametricEq,
      })

      if (!loadResult.ok) {
        throw {
          code: loadResult.error?.code ?? 'native-audio-load-failed',
          message: loadResult.error?.message ?? 'Failed to load decrypted Apple Music audio.',
        }
      }
      // Push metadata to UI immediately, even if sidecar metadata event is delayed.
      this.status = 'ready'
      this.emit('loadedmetadata')

      if (request.autoplay) {
        const playResult = await api.nativeAudioPlay()
        if (!playResult.ok) {
          throw {
            code: playResult.error?.code ?? 'native-audio-play-failed',
            message: playResult.error?.message ?? 'Failed to start playback after load.',
          }
        }
        this.isPlaying = true
        this.status = 'playing'
      }

      logger.info(LOG_TAG, `Loaded adamId ${adamId} successfully`)
    } catch (error) {
      const message =
        typeof error === 'object' && error !== null && 'message' in error
          ? String((error as { message: unknown }).message)
          : String(error)
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code: unknown }).code)
          : 'apple-music-load-failed'

      logger.error(LOG_TAG, 'Load failed', { code, message })
      this.status = 'error'
      this.errorMessage = message
      this.emit('error')
      throw { code, message }
    }
  }

  async play(): Promise<void> {
    if (this.pendingPlay) {
      await this.pendingPlay
      return
    }

    const task = this.playInternal()
    this.pendingPlay = task
    try {
      await task
    } finally {
      if (this.pendingPlay === task) {
        this.pendingPlay = null
      }
    }
  }

  private async playInternal(): Promise<void> {
    const api = readApi()
    if (!api) throw { code: 'native-api-unavailable', message: 'Native audio API is not available.' }

    if (this.pendingLoad) {
      logger.info(LOG_TAG, 'Play requested while load is in-flight. Waiting for load to finish.')
      await this.pendingLoad
    }

    await this.ensureInitialized()
    const result = await api.nativeAudioPlay()
    if (!result.ok) {
      throw {
        code: result.error?.code ?? 'native-audio-play-failed',
        message: result.error?.message ?? 'Failed to start playback.',
      }
    }
    this.isPlaying = true
    this.status = 'playing'
  }

  pause(): void {
    const api = readApi()
    if (!api || this.disposed) return

    api.nativeAudioPause().catch((error) => {
      logger.error(LOG_TAG, 'pause failed', error)
      this.status = 'error'
      this.errorMessage = 'Failed to pause.'
      this.emit('error')
    })
  }

  seek(positionSeconds: number): void {
    const api = readApi()
    if (!api || this.disposed) return

    const nextPosition = normalizeTime(positionSeconds)
    this.currentTimeSeconds = nextPosition

    api.nativeAudioSeek(nextPosition).catch((error) => {
      logger.error(LOG_TAG, 'seek failed', error)
      this.status = 'error'
      this.errorMessage = 'Failed to seek.'
      this.emit('error')
    })
  }

  setVolume(volume: number): void {
    const api = readApi()
    if (!api || this.disposed) return

    const nextVolume = clampVolume(volume)
    this.volume = nextVolume

    api.nativeAudioSetVolume(nextVolume).catch((error) => {
      logger.error(LOG_TAG, 'setVolume failed', error)
      this.status = 'error'
      this.errorMessage = 'Failed to set volume.'
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
    this.currentAdamId = null

    const api = readApi()
    if (!api) return

    api.nativeAudioDispose().catch((error) => {
      logger.error(LOG_TAG, 'dispose failed', error)
    })
  }
}
