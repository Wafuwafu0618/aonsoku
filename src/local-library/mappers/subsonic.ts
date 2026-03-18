import { LocalTrack } from '@/local-library/types'
import { ISong } from '@/types/responses/song'

const defaultReplayGain = {
  trackGain: 0,
  trackPeak: 1,
  albumGain: 0,
  albumPeak: 1,
}

export function getContentType(format: string): string {
  const mimeTypes: Record<string, string> = {
    mp3: 'audio/mpeg',
    flac: 'audio/flac',
    aac: 'audio/aac',
    alac: 'audio/mp4',
    m4a: 'audio/mp4',
  }

  return mimeTypes[format] || 'audio/mpeg'
}

export function createLocalArtistId(artistName: string): string {
  const normalizedArtist = (artistName || 'Unknown Artist').trim()
  return `local-artist:${encodeURIComponent(normalizedArtist)}`
}

export function isLocalArtistId(artistId: string): boolean {
  return artistId.startsWith('local-artist:')
}

export function createLocalAlbumId(
  albumName: string,
  albumArtistName: string,
): string {
  const normalizedAlbum = (albumName || 'Unknown Album').trim()
  const normalizedAlbumArtist = (albumArtistName || 'Unknown Artist').trim()

  return `local-album:${encodeURIComponent(normalizedAlbum)}:${encodeURIComponent(normalizedAlbumArtist)}`
}

export function createLocalAlbumIdFromTrack(track: LocalTrack): string {
  const albumArtist = track.albumArtist || track.artist || 'Unknown Artist'
  return createLocalAlbumId(track.album, albumArtist)
}

export function isLocalAlbumId(albumId: string): boolean {
  return albumId.startsWith('local-album:')
}

export function toLocalSongId(trackId: string): string {
  return trackId.startsWith('local:') ? trackId : `local:${trackId}`
}

function getCreatedIsoString(track: LocalTrack): string {
  if (Number.isFinite(track.createdAt)) {
    return new Date(track.createdAt).toISOString()
  }

  return new Date(0).toISOString()
}

export function convertLocalTrackToISong(track: LocalTrack): ISong {
  const id = toLocalSongId(track.id)
  const artist = track.artist || 'Unknown Artist'
  const album = track.album || 'Unknown Album'
  const albumArtist = track.albumArtist?.trim()
  const artistId = createLocalArtistId(artist)
  const albumId = createLocalAlbumId(
    album,
    albumArtist || artist || 'Unknown Artist',
  )
  const genreName = track.genre?.trim()
  const created = getCreatedIsoString(track)

  return {
    id,
    parent: '',
    isDir: false,
    title: track.title || 'Unknown Track',
    album,
    artist,
    track: track.trackNumber ?? 0,
    year: track.year ?? 0,
    genre: genreName,
    coverArt: track.coverArt || '',
    size: track.fileSize,
    contentType: getContentType(track.format),
    suffix: track.format || 'other',
    duration: track.duration ?? 0,
    bitRate: track.bitrate ?? 0,
    path: track.filePath,
    discNumber: track.discNumber ?? 0,
    created,
    albumId,
    artistId,
    type: 'music',
    isVideo: false,
    bpm: 0,
    comment: '',
    sortName: track.title || 'Unknown Track',
    mediaType: 'music',
    musicBrainzId: '',
    genres: genreName ? [{ name: genreName }] : [],
    replayGain: defaultReplayGain,
    channelCount: track.channels,
    samplingRate: track.sampleRate,
    artists: [{ id: artistId, name: artist }],
    displayArtist: artist,
    albumArtists: albumArtist
      ? [
          {
            id: `local-album-artist:${encodeURIComponent(albumArtist)}`,
            name: albumArtist,
          },
        ]
      : undefined,
    displayAlbumArtist: albumArtist,
  }
}
