import { PlaybackBackendId } from '@/domain/playback-backend'
import { MediaSource } from '@/domain/media-source'
import { MediaTrack } from './track'

export interface QueueItem {
  id: string
  mediaType: 'track'
  source: MediaSource
  sourceId: string
  playbackBackend: PlaybackBackendId
  title: string
  primaryArtist: string
  albumTitle: string
  durationSeconds: number
  coverArtId?: string
  track: MediaTrack
}
