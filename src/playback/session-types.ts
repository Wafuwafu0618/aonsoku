import { PlaybackBackendId } from '@/domain/playback-backend'

export type PlaybackStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'ended'
  | 'error'

export interface PlaybackLoadRequest {
  src: string
  loop?: boolean
  autoplay?: boolean
  startAtSeconds?: number
  playbackRate?: number
  durationSeconds?: number
}

export interface PlaybackSnapshot {
  backendId: PlaybackBackendId
  status: PlaybackStatus
  isPlaying: boolean
  currentTimeSeconds: number
  durationSeconds: number
  volume: number
  loop: boolean
  playbackRate: number
  error?: string
}

export type PlaybackEventType =
  | 'loadedmetadata'
  | 'timeupdate'
  | 'play'
  | 'pause'
  | 'ended'
  | 'error'

export interface PlaybackEvent {
  type: PlaybackEventType
  snapshot: PlaybackSnapshot
}
