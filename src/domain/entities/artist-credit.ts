import { MediaSource } from '@/domain/media-source'

export interface ArtistCredit {
  id?: string
  name: string
  source: MediaSource
}
