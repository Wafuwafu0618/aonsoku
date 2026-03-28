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

export type PlaybackAnalogColorPreset = 'light' | 'standard' | 'strong'

export interface PlaybackAnalogColorConfig {
  preset: PlaybackAnalogColorPreset
}

export type PlaybackCrossfeedPreset = 'low' | 'medium' | 'high'

export interface PlaybackCrossfeedConfig {
  preset: PlaybackCrossfeedPreset
}

export interface PlaybackDspMeter {
  peakDbfs: number
  truePeakDbfs: number
  clipCountWindow: number
  clipCountTotal: number
  clippingDetected: boolean
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
  headroomDb?: number
  crossfeed?: PlaybackCrossfeedConfig
  parametricEq?: PlaybackParametricEqConfig
  analogColor?: PlaybackAnalogColorConfig
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
  meter?: PlaybackDspMeter
  error?: string
}

export type PlaybackEventType =
  | 'loadedmetadata'
  | 'timeupdate'
  | 'play'
  | 'pause'
  | 'ended'
  | 'error'
  | 'meter'

export interface PlaybackEvent {
  type: PlaybackEventType
  snapshot: PlaybackSnapshot
}
