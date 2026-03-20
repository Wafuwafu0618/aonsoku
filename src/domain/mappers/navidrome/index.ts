import { Albums, SingleAlbum } from '@/types/responses/album'
import { Playlist, PlaylistWithEntries } from '@/types/responses/playlist'
import { ISong } from '@/types/responses/song'
import { createDomainId } from '@/domain/id'
import { MediaAlbumSummary } from '@/domain/entities/album'
import { ArtistCredit } from '@/domain/entities/artist-credit'
import { MediaPlaylistSummary } from '@/domain/entities/playlist'
import { QueueItem } from '@/domain/entities/queue-item'
import { MediaTrack } from '@/domain/entities/track'
import { MediaSource } from '@/domain/media-source'

const navidromeSource = 'navidrome' as const
const internalBackend = 'internal' as const

function resolveSongSource(song: ISong): MediaSource {
  if (song.id.startsWith('local:')) return 'local'
  if (song.id.startsWith('spotify:')) return 'spotify'

  return navidromeSource
}

function resolveSongSourceId(song: ISong, source: MediaSource): string {
  if (source === 'local') {
    return song.id.replace(/^local:/, '') || song.id
  }

  if (source === 'spotify') {
    return song.id.replace(/^spotify:/, '') || song.id
  }

  return song.id
}

function getArtistCredits(song: ISong, source: MediaSource): ArtistCredit[] {
  if (song.artists && song.artists.length > 0) {
    return song.artists.map((artist) => ({
      id: artist.id,
      name: artist.name,
      source,
    }))
  }

  return [
    {
      id: song.artistId,
      name: song.artist,
      source,
    },
  ]
}

function getGenreNames(song: Pick<ISong, 'genre' | 'genres'>): string[] {
  if (song.genres && song.genres.length > 0) {
    return song.genres.map((genre) => genre.name)
  }

  return song.genre ? [song.genre] : []
}

function getAlbumGenreNames(album: Pick<Albums, 'genre' | 'genres'>): string[] {
  if (album.genres && album.genres.length > 0) {
    return album.genres.map((genre) => genre.name)
  }

  return album.genre ? [album.genre] : []
}

export function mapNavidromeSongToTrack(song: ISong): MediaTrack {
  const source = resolveSongSource(song)
  const sourceId = resolveSongSourceId(song, source)

  return {
    kind: 'track',
    id: createDomainId(source, sourceId),
    source,
    sourceId,
    playbackBackend: internalBackend,
    title: song.title,
    albumTitle: song.album,
    albumId: song.albumId,
    primaryArtist: song.artist,
    artistId: song.artistId,
    artists: getArtistCredits(song, source),
    trackNumber: song.track,
    discNumber: song.discNumber,
    year: song.year,
    durationSeconds: song.duration,
    coverArtId: song.coverArt,
    genreNames: getGenreNames(song),
    contentType: song.contentType,
    suffix: song.suffix,
    bitRate: song.bitRate,
    bitDepth: song.bitDepth,
    samplingRate: song.samplingRate,
    channelCount: song.channelCount,
    path: song.path,
    starredAt: song.starred,
    playedAt: song.played,
    replayGain: song.replayGain,
  }
}

export function mapNavidromeSongsToTracks(songs: ISong[]): MediaTrack[] {
  return songs.map(mapNavidromeSongToTrack)
}

export function mapNavidromeSongToQueueItem(song: ISong): QueueItem {
  const track = mapNavidromeSongToTrack(song)

  return {
    id: track.id,
    mediaType: 'track',
    source: track.source,
    sourceId: track.sourceId,
    playbackBackend: track.playbackBackend,
    title: track.title,
    primaryArtist: track.primaryArtist,
    albumTitle: track.albumTitle,
    durationSeconds: track.durationSeconds,
    coverArtId: track.coverArtId,
    track,
  }
}

export function mapNavidromeSongsToQueueItems(songs: ISong[]): QueueItem[] {
  return songs.map(mapNavidromeSongToQueueItem)
}

export function mapNavidromeAlbumToSummary(
  album: Albums | SingleAlbum,
): MediaAlbumSummary {
  return {
    kind: 'album',
    id: createDomainId(navidromeSource, album.id),
    source: navidromeSource,
    sourceId: album.id,
    title: album.name,
    artistName: album.artist,
    artistId: album.artistId,
    coverArtId: album.coverArt,
    songCount: album.songCount,
    durationSeconds: album.duration,
    year: album.year,
    genreNames: getAlbumGenreNames(album),
    playCount: album.playCount,
    starredAt: album.starred,
    playedAt: album.played,
    explicitStatus: album.explicitStatus,
    version: album.version,
  }
}

export function mapNavidromeAlbumsToSummaries(
  albums: Array<Albums | SingleAlbum>,
): MediaAlbumSummary[] {
  return albums.map(mapNavidromeAlbumToSummary)
}

export function mapNavidromePlaylistToSummary(
  playlist: Playlist | PlaylistWithEntries,
): MediaPlaylistSummary {
  const updatedAt = 'changed' in playlist ? playlist.changed : undefined

  return {
    kind: 'playlist',
    id: createDomainId(navidromeSource, playlist.id),
    source: navidromeSource,
    sourceId: playlist.id,
    name: playlist.name,
    comment: playlist.comment,
    coverArtId: playlist.coverArt,
    songCount: playlist.songCount,
    durationSeconds: playlist.duration,
    public: playlist.public,
    owner: playlist.owner,
    createdAt: playlist.created,
    updatedAt,
  }
}

export function mapNavidromePlaylistsToSummaries(
  playlists: Array<Playlist | PlaylistWithEntries>,
): MediaPlaylistSummary[] {
  return playlists.map(mapNavidromePlaylistToSummary)
}
