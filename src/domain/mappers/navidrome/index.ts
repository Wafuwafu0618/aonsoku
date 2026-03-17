import { Albums, SingleAlbum } from '@/types/responses/album'
import { Playlist, PlaylistWithEntries } from '@/types/responses/playlist'
import { ISong } from '@/types/responses/song'
import { createDomainId } from '@/domain/id'
import { MediaAlbumSummary } from '@/domain/entities/album'
import { ArtistCredit } from '@/domain/entities/artist-credit'
import { MediaPlaylistSummary } from '@/domain/entities/playlist'
import { QueueItem } from '@/domain/entities/queue-item'
import { MediaTrack } from '@/domain/entities/track'

const navidromeSource = 'navidrome' as const
const internalBackend = 'internal' as const

function getArtistCredits(song: ISong): ArtistCredit[] {
  if (song.artists && song.artists.length > 0) {
    return song.artists.map((artist) => ({
      id: artist.id,
      name: artist.name,
      source: navidromeSource,
    }))
  }

  return [
    {
      id: song.artistId,
      name: song.artist,
      source: navidromeSource,
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
  return {
    kind: 'track',
    id: createDomainId(navidromeSource, song.id),
    source: navidromeSource,
    sourceId: song.id,
    playbackBackend: internalBackend,
    title: song.title,
    albumTitle: song.album,
    albumId: song.albumId,
    primaryArtist: song.artist,
    artistId: song.artistId,
    artists: getArtistCredits(song),
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
