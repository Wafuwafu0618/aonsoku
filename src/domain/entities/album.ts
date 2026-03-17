import { MediaSource } from '@/domain/media-source'

export interface MediaAlbumSummary {
  kind: 'album'
  id: string
  source: MediaSource
  sourceId: string
  title: string
  artistName: string
  artistId?: string
  coverArtId?: string
  songCount: number
  durationSeconds: number
  year?: number
  genreNames: string[]
  playCount?: number
  starredAt?: string
  playedAt?: string
  explicitStatus?: string
  version?: string
}
