import { MediaSource } from '@/domain/media-source'

export interface MediaPlaylistSummary {
  kind: 'playlist'
  id: string
  source: MediaSource
  sourceId: string
  name: string
  comment?: string
  coverArtId?: string
  songCount: number
  durationSeconds: number
  public?: boolean
  owner?: string
  createdAt?: string
  updatedAt?: string
}
