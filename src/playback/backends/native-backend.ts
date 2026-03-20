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

const EXCLUSIVE_RECOVERABLE_ERROR_CODES = new Set([
  'exclusive-device-busy',
  'exclusive-not-allowed',
  'exclusive-format-unsupported',
  'exclusive-device-unavailable',
  'exclusive-open-failed',
  'output-init-failed',
])
const EXCLUSIVE_DEVICE_CHANGED_DEBOUNCE_MS = 900
const EXCLUSIVE_RETRY_DELAYS_MS = [300, 700, 1500]
const EXCLUSIVE_WAIT_FOR_NEXT_DEVICE_CHANGE_MS = 3500
const DEVICE_CHANGE_POLL_INTERVAL_MS = 100

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

function normalizeSource(value: string): string {
  try {
    const baseUrl =
      typeof window !== 'undefined' ? window.location.href : 'http://localhost'

    return new URL(value, baseUrl).toString()
  } catch {
    return value
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
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

function isRecoverableExclusiveModeError(
  error: NativeAudioErrorPayload | undefined,
): boolean {
  if (!error) return false

  return EXCLUSIVE_RECOVERABLE_ERROR_CODES.has(error.code)
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
  private pendingLoad: Promise<void> | null = null
  private lastDeviceChangedAt = 0
  private deviceChangeSequence = 0
  private currentSource: string | null = null
  private currentTargetSampleRateHz: number | undefined
  private currentOversamplingFilterId: string | undefined
  private currentParametricEqSignature: string | undefined

  private outputMode: NativeAudioOutputMode

  constructor(options: NativePlaybackBackendOptions) {
    this.outputMode = options.outputMode
    this.attachEventListener()
  }

  private async setOutputModeWithFallback(
    api: IAonsokuAPI,
    mode: NativeAudioOutputMode,
  ): Promise<void> {
    const result =
      mode === 'wasapi-exclusive'
        ? await this.setExclusiveModeWithRetry(api)
        : await api.nativeAudioSetOutputMode(mode)
    if (result.ok) {
      this.outputMode = mode
      return
    }

    if (
      mode === 'wasapi-exclusive' &&
      isRecoverableExclusiveModeError(result.error)
    ) {
      logger.warn(
        '[NativePlaybackBackend] Falling back to wasapi-shared because exclusive mode is unavailable',
        {
          code: result.error?.code,
          message: result.error?.message,
        },
      )

      const fallbackResult = await api.nativeAudioSetOutputMode('wasapi-shared')
      ensureResultOk(
        fallbackResult,
        'native-audio-set-output-mode-failed',
        'Failed to fallback to wasapi-shared output mode.',
      )

      this.outputMode = 'wasapi-shared'
      return
    }

    ensureResultOk(
      result,
      'native-audio-set-output-mode-failed',
      `Failed to set native output mode: ${mode}`,
    )
  }

  private async setExclusiveModeWithRetry(
    api: IAonsokuAPI,
  ): Promise<NativeAudioCommandResult> {
    const sinceLastDeviceChange = Date.now() - this.lastDeviceChangedAt
    if (
      this.lastDeviceChangedAt > 0 &&
      sinceLastDeviceChange < EXCLUSIVE_DEVICE_CHANGED_DEBOUNCE_MS
    ) {
      await sleep(EXCLUSIVE_DEVICE_CHANGED_DEBOUNCE_MS - sinceLastDeviceChange)
    }

    const result = await this.trySetExclusiveWithDelays(
      api,
      EXCLUSIVE_RETRY_DELAYS_MS,
    )
    if (result.ok || !isRecoverableExclusiveModeError(result.error)) {
      return result
    }

    const sequenceAtFailure = this.deviceChangeSequence
    const observedNextDeviceChange = await this.waitForDeviceChange(
      sequenceAtFailure,
      EXCLUSIVE_WAIT_FOR_NEXT_DEVICE_CHANGE_MS,
    )

    if (!observedNextDeviceChange) {
      return result
    }

    const afterNextDeviceChange = Date.now() - this.lastDeviceChangedAt
    if (afterNextDeviceChange < EXCLUSIVE_DEVICE_CHANGED_DEBOUNCE_MS) {
      await sleep(EXCLUSIVE_DEVICE_CHANGED_DEBOUNCE_MS - afterNextDeviceChange)
    }

    return this.trySetExclusiveWithDelays(api, EXCLUSIVE_RETRY_DELAYS_MS)
  }

  private async trySetExclusiveWithDelays(
    api: IAonsokuAPI,
    delaysMs: readonly number[],
  ): Promise<NativeAudioCommandResult> {
    let result = await api.nativeAudioSetOutputMode('wasapi-exclusive')
    if (result.ok || !isRecoverableExclusiveModeError(result.error)) {
      return result
    }

    for (const delayMs of delaysMs) {
      await sleep(delayMs)
      result = await api.nativeAudioSetOutputMode('wasapi-exclusive')
      if (result.ok || !isRecoverableExclusiveModeError(result.error)) {
        return result
      }
    }

    return result
  }

  private async waitForDeviceChange(
    sequence: number,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      if (this.deviceChangeSequence > sequence) {
        return true
      }
      await sleep(DEVICE_CHANGE_POLL_INTERVAL_MS)
    }

    return false
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
      this.lastDeviceChangedAt = Date.now()
      this.deviceChangeSequence += 1
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

    await this.setOutputModeWithFallback(api, this.outputMode)

    this.initialized = true
  }

  async setOutputMode(mode: NativeAudioOutputMode): Promise<void> {
    const previousMode = this.outputMode
    this.outputMode = mode

    if (!this.initialized) return
    if (previousMode === mode) return

    const api = readApi()
    if (!api) {
      throw {
        code: 'native-api-unavailable',
        message: 'Native audio API is not available.',
      }
    }

    await this.setOutputModeWithFallback(api, mode)
  }

  getOutputMode(): NativeAudioOutputMode {
    return this.outputMode
  }

  async load(request: PlaybackLoadRequest): Promise<void> {
    const loadTask = this.loadInternal(request)
    this.pendingLoad = loadTask

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
      const error = {
        code: 'native-api-unavailable',
        message: 'Native audio API is not available.',
      }
      this.status = 'error'
      this.errorMessage = error.message
      this.emit('error')
      throw error
    }

    const normalizedSrc = normalizeSource(request.src)
    const requestedTargetSampleRateHz =
      typeof request.targetSampleRateHz === 'number'
        ? request.targetSampleRateHz
        : undefined
    const requestedOversamplingFilterId =
      typeof request.oversamplingFilterId === 'string' &&
      request.oversamplingFilterId.length > 0
        ? request.oversamplingFilterId
        : undefined
    const requestedParametricEqSignature =
      request.parametricEq && request.parametricEq.bands.length > 0
        ? JSON.stringify(request.parametricEq)
        : undefined
    const sameSource = this.currentSource === normalizedSrc
    const sameTargetRate =
      this.currentTargetSampleRateHz === requestedTargetSampleRateHz
    const sameOversamplingFilter =
      this.currentOversamplingFilterId === requestedOversamplingFilterId
    const sameParametricEq =
      this.currentParametricEqSignature === requestedParametricEqSignature
    const sameLoop =
      typeof request.loop !== 'boolean' || request.loop === this.loop
    const samePlaybackRate =
      typeof request.playbackRate !== 'number' ||
      request.playbackRate === this.playbackRate
    const hasExplicitSeek =
      typeof request.startAtSeconds === 'number' &&
      Number.isFinite(request.startAtSeconds)

    if (
      sameSource &&
      sameTargetRate &&
      sameOversamplingFilter &&
      sameParametricEq &&
      sameLoop &&
      samePlaybackRate &&
      !hasExplicitSeek
    ) {
      if (request.autoplay && !this.isPlaying) {
        const playResult = await api.nativeAudioPlay()
        ensureResultOk(
          playResult,
          'native-audio-play-failed',
          'Failed to start native audio playback.',
        )
      }
      return
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
      if (
        !result.ok &&
        this.outputMode === 'wasapi-exclusive' &&
        isRecoverableExclusiveModeError(result.error)
      ) {
        logger.warn(
          '[NativePlaybackBackend] Retrying load with wasapi-shared because exclusive mode load failed',
          {
            code: result.error?.code,
            message: result.error?.message,
          },
        )

        const fallbackResult = await api.nativeAudioSetOutputMode('wasapi-shared')
        ensureResultOk(
          fallbackResult,
          'native-audio-set-output-mode-failed',
          'Failed to fallback to wasapi-shared output mode.',
        )
        this.outputMode = 'wasapi-shared'

        const retryResult = await api.nativeAudioLoad(request)
        ensureResultOk(
          retryResult,
          'native-audio-load-failed',
          'Failed to load native audio source.',
        )
        this.currentSource = normalizedSrc
        this.currentTargetSampleRateHz = requestedTargetSampleRateHz
        this.currentOversamplingFilterId = requestedOversamplingFilterId
        this.currentParametricEqSignature = requestedParametricEqSignature
        return
      }

      ensureResultOk(
        result,
        'native-audio-load-failed',
        'Failed to load native audio source.',
      )

      this.currentSource = normalizedSrc
      this.currentTargetSampleRateHz = requestedTargetSampleRateHz
      this.currentOversamplingFilterId = requestedOversamplingFilterId
      this.currentParametricEqSignature = requestedParametricEqSignature
    } catch (error) {
      const payload = toErrorPayload(
        error,
        'native-audio-load-failed',
        'Failed to load native audio source.',
      )
      this.currentSource = null
      this.currentTargetSampleRateHz = undefined
      this.currentOversamplingFilterId = undefined
      this.currentParametricEqSignature = undefined
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
      if (this.pendingLoad) {
        await this.pendingLoad
      }

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
    this.currentSource = null
    this.currentTargetSampleRateHz = undefined
    this.currentOversamplingFilterId = undefined
    this.currentParametricEqSignature = undefined

    const api = readApi()
    if (!api) return

    api.nativeAudioDispose().catch((error) => {
      logger.error('[NativePlaybackBackend] dispose failed', error)
    })
  }
}
