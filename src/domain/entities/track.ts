import { PlaybackBackendId } from '@/domain/playback-backend'
import { MediaSource } from '@/domain/media-source'
import { ArtistCredit } from './artist-credit'

export interface ReplayGainProfile {
  trackGain?: number
  trackPeak?: number
  albumGain?: number
  albumPeak?: number
}

export interface MediaTrack {
  kind: 'track'
  id: string
  source: MediaSource
  sourceId: string
  playbackBackend: PlaybackBackendId
  title: string
  albumTitle: string
  albumId?: string
  primaryArtist: string
  artistId?: string
  artists: ArtistCredit[]
  trackNumber?: number
  discNumber?: number
  year?: number
  durationSeconds: number
  coverArtId?: string
  genreNames: string[]
  contentType?: string
  suffix?: string
  bitRate?: number
  bitDepth?: number
  samplingRate?: number
  channelCount?: number
  path?: string
  starredAt?: string
  playedAt?: string
  replayGain?: ReplayGainProfile
}
