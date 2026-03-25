import { MediaTrack } from '@/domain/entities/track'
import { AppleMusicAlbum, AppleMusicSong } from '@/types/responses/apple-music'
import { ISong } from '@/types/responses/song'

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
  const sourceId = resolveAppleMusicSongSourceId(song)
  const genreNames = Array.isArray(song.genreNames) ? song.genreNames : []

  return {
    kind: 'track',
    id: `am-${sourceId}`,
    source: 'apple-music',
    sourceId,
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
    genreNames,
    trackNumber: song.trackNumber,
    discNumber: song.discNumber,
    adamId: sourceId,
    appleMusicUrl: song.url,
  }
}

export function mapAppleMusicSongsToMediaTracks(
  songs: AppleMusicSong[],
): MediaTrack[] {
  return songs.map(mapAppleMusicSongToMediaTrack)
}

function resolveAppleMusicSongSourceId(
  song: Pick<AppleMusicSong, 'adamId' | 'id'>,
): string {
  const adamId = song.adamId.trim()
  if (adamId.length > 0) return adamId

  const id = song.id.trim()
  if (id.length > 0) return id

  return 'unknown'
}

export function mapAppleMusicSongToAppSong(song: AppleMusicSong): ISong {
  const sourceId = resolveAppleMusicSongSourceId(song)
  const genreNames = Array.isArray(song.genreNames) ? song.genreNames : []

  return {
    id: `apple-music:${sourceId}`,
    parent: '',
    isDir: false,
    title: song.title,
    album: song.albumName,
    artist: song.artistName,
    track: song.trackNumber ?? 0,
    year: 0,
    genre: genreNames[0],
    coverArt: song.artworkUrl || '',
    size: 0,
    contentType: 'audio/aac',
    suffix: 'm4a',
    duration: Math.max(0, Math.floor(song.durationMs / 1000)),
    bitRate: 256,
    path: `apple-music://${sourceId}`,
    discNumber: song.discNumber ?? 0,
    created: new Date().toISOString(),
    albumId: `apple-music-album:${song.albumName || 'unknown'}`,
    artistId: '',
    type: 'music',
    isVideo: false,
    bpm: 0,
    comment: '',
    sortName: song.title,
    mediaType: 'music',
    musicBrainzId: '',
    genres: genreNames.map((name) => ({ name })),
    replayGain: {
      trackGain: 0,
      trackPeak: 1,
      albumGain: 0,
      albumPeak: 1,
    },
  }
}

export function mapAppleMusicSongsToAppSongs(
  songs: AppleMusicSong[],
): ISong[] {
  return songs.map(mapAppleMusicSongToAppSong)
}

export function resolveAppleMusicAlbumDetailId(
  album: Pick<AppleMusicAlbum, 'id' | 'catalogId'>,
): string {
  const catalogId = album.catalogId?.trim()
  if (catalogId && catalogId.length > 0) return catalogId
  return album.id
}
