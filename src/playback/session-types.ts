import { PlaybackBackendId } from '@/domain/playback-backend'

export type PlaybackParametricEqFilterType = 'PK' | 'LSC' | 'HSC'

export interface PlaybackParametricEqBand {
  enabled: boolean
  type: PlaybackParametricEqFilterType
  frequencyHz: number
  gainDb: number
  q: number
}

export interface PlaybackParametricEqConfig {
  preampDb: number
  bands: PlaybackParametricEqBand[]
}

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
  targetSampleRateHz?: number
  oversamplingFilterId?: string
  parametricEq?: PlaybackParametricEqConfig
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
