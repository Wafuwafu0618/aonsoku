import { PlaybackBackendId } from '@/domain/playback-backend'
import {
  PlaybackEvent,
  PlaybackLoadRequest,
  PlaybackSnapshot,
} from './session-types'

export interface PlaybackBackendCapabilities {
  canSeek: boolean
  canSetVolume: boolean
  emitsTimeUpdates: boolean
}

export type PlaybackSubscription = (event: PlaybackEvent) => void
export type PlaybackUnsubscribe = () => void

export interface PlaybackBackend {
  readonly id: PlaybackBackendId
  readonly capabilities: PlaybackBackendCapabilities

  load(request: PlaybackLoadRequest): Promise<void>
  play(): Promise<void>
  pause(): void
  seek(positionSeconds: number): void
  setVolume(volume: number): void

  getSnapshot(): PlaybackSnapshot
  subscribe(listener: PlaybackSubscription): PlaybackUnsubscribe

  dispose(): void
}
