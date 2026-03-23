import { MediaTrack } from '@/domain/entities/track'
import { AppleMusicSong } from '@/types/responses/apple-music'

export function resolveAppleMusicArtworkUrl(
  template: string,
  width: number,
  height: number,
): string {
  return template
    .replace('{w}', String(width))
    .replace('{h}', String(height))
}

export function mapAppleMusicSongToMediaTrack(song: AppleMusicSong): MediaTrack {
  return {
    kind: 'track',
    id: `am-${song.adamId}`,
    source: 'apple-music',
    sourceId: song.adamId,
    playbackBackend: 'apple-music',
    title: song.title,
    albumTitle: song.albumName,
    primaryArtist: song.artistName,
    artists: [
      {
        id: '',
        name: song.artistName,
        source: 'apple-music',
      },
    ],
    durationSeconds: song.durationMs / 1000,
    coverArtId: song.artworkUrl,
    genreNames: song.genreNames,
    trackNumber: song.trackNumber,
    discNumber: song.discNumber,
    adamId: song.adamId,
    appleMusicUrl: song.url,
  }
}

export function mapAppleMusicSongsToMediaTracks(
  songs: AppleMusicSong[],
): MediaTrack[] {
  return songs.map(mapAppleMusicSongToMediaTrack)
}
