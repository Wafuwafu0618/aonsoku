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

function normalizeSource(value: string): string {
  try {
    const baseUrl =
      typeof window !== 'undefined' ? window.location.href : 'http://localhost'

    return new URL(value, baseUrl).toString()
  } catch {
    return value
  }
}

export class InternalPlaybackBackend implements PlaybackBackend {
  readonly id = 'internal' as const
  readonly capabilities = capabilities

  private listeners = new Set<PlaybackSubscription>()
  private status: PlaybackStatus = 'idle'

  private onLoadedMetadata = () => {
    this.status = 'ready'
    this.emit('loadedmetadata')
  }

  private onTimeUpdate = () => {
    this.emit('timeupdate')
  }

  private onPlay = () => {
    this.status = 'playing'
    this.emit('play')
  }

  private onPause = () => {
    if (this.audio.ended) {
      this.status = 'ended'
    } else {
      this.status = 'paused'
    }
    this.emit('pause')
  }

  private onEnded = () => {
    this.status = 'ended'
    this.emit('ended')
  }

  private onError = () => {
    this.status = 'error'
    this.emit('error')
  }

  constructor(private audio: HTMLAudioElement) {
    this.bindAudioEvents()
  }

  private bindAudioEvents() {
    this.audio.addEventListener('loadedmetadata', this.onLoadedMetadata)
    this.audio.addEventListener('timeupdate', this.onTimeUpdate)
    this.audio.addEventListener('play', this.onPlay)
    this.audio.addEventListener('pause', this.onPause)
    this.audio.addEventListener('ended', this.onEnded)
    this.audio.addEventListener('error', this.onError)
  }

  private unbindAudioEvents() {
    this.audio.removeEventListener('loadedmetadata', this.onLoadedMetadata)
    this.audio.removeEventListener('timeupdate', this.onTimeUpdate)
    this.audio.removeEventListener('play', this.onPlay)
    this.audio.removeEventListener('pause', this.onPause)
    this.audio.removeEventListener('ended', this.onEnded)
    this.audio.removeEventListener('error', this.onError)
  }

  private emit(type: PlaybackEventType) {
    const event: PlaybackEvent = {
      type,
      snapshot: this.getSnapshot(),
    }

    this.listeners.forEach((listener) => listener(event))
  }

  async load(request: PlaybackLoadRequest): Promise<void> {
    const {
      src,
      autoplay = false,
      loop,
      startAtSeconds,
      playbackRate,
    } = request

    const currentSource = normalizeSource(this.audio.src)
    const nextSource = normalizeSource(src)
    const sourceHasChanged = currentSource !== nextSource

    if (typeof loop === 'boolean') {
      this.audio.loop = loop
    }

    if (typeof playbackRate === 'number') {
      this.audio.playbackRate = playbackRate
    }

    if (sourceHasChanged) {
      this.status = 'loading'
      this.audio.src = src
      this.audio.load()
    }

    if (typeof startAtSeconds === 'number' && Number.isFinite(startAtSeconds)) {
      this.seek(startAtSeconds)
    }

    if (autoplay) {
      await this.play()
    }
  }

  async play(): Promise<void> {
    await this.audio.play()
  }

  pause(): void {
    this.audio.pause()
  }

  seek(positionSeconds: number): void {
    this.audio.currentTime = normalizeTime(positionSeconds)
  }

  setVolume(volume: number): void {
    this.audio.volume = clampVolume(volume)
  }

  getSnapshot(): PlaybackSnapshot {
    return {
      backendId: this.id,
      status: this.status,
      isPlaying: !this.audio.paused,
      currentTimeSeconds: normalizeTime(this.audio.currentTime),
      durationSeconds: normalizeTime(this.audio.duration),
      volume: clampVolume(this.audio.volume),
      loop: this.audio.loop,
      playbackRate: this.audio.playbackRate,
      error: this.audio.error?.message,
    }
  }

  subscribe(listener: PlaybackSubscription): PlaybackUnsubscribe {
    this.listeners.add(listener)

    return () => {
      this.listeners.delete(listener)
    }
  }

  dispose(): void {
    this.unbindAudioEvents()
    this.listeners.clear()
    this.status = 'idle'
  }
}
