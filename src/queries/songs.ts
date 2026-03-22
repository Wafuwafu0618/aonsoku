import {
  convertLocalTrackToISong,
  createLocalArtistId,
  getAllTracks,
  getTracksCount,
  getTracksPage,
  searchTracksCount,
  searchTracksPage,
} from '@/local-library'
import { SearchQueryOptions } from '@/service/search'
import {
  getSpotifySongYearFromReleaseDate,
  spotifySearchTracks,
} from '@/service/spotify'
import { subsonic } from '@/service/subsonic'
import { useAppStore } from '@/store/app.store'
import { ISong } from '@/types/responses/song'

const NAVIDROME_COUNT_PAGE_SIZE = 100

type SongSearchParams = Required<
  Pick<SearchQueryOptions, 'query' | 'songCount' | 'songOffset'>
> & {
  source?: 'all' | 'navidrome' | 'local' | 'spotify'
}

export interface SongSearchResult {
  songs: ISong[]
  nextOffset: number | null
  totalCount?: number
}

const navidromeSongCountCache = new Map<string, number>()
const navidromeSongCountInFlight = new Map<string, Promise<number>>()

const spotifyDefaultReplayGain = {
  trackGain: 0,
  trackPeak: 1,
  albumGain: 0,
  albumPeak: 1,
}

function mapSpotifyTrackToISong(track: Awaited<
  ReturnType<typeof spotifySearchTracks>
>['tracks'][number]): ISong {
  const primaryArtist = track.artists[0]
  const artists = track.artists
    .filter((artist) => Boolean(artist.name))
    .map((artist) => ({
      id: artist.uri || `spotify:artist:${artist.id}`,
      name: artist.name,
    }))

  const artistName =
    artists.map((artist) => artist.name).join(', ') ||
    primaryArtist?.name ||
    'Unknown Artist'
  const artistId = primaryArtist?.uri || `spotify:artist:${primaryArtist?.id ?? ''}`
  const releaseYear = getSpotifySongYearFromReleaseDate(track.album.releaseDate)

  return {
    id: track.uri,
    parent: '',
    isDir: false,
    title: track.title,
    album: track.album.title,
    artist: artistName,
    track: track.trackNumber,
    year: releaseYear,
    genre: '',
    coverArt: track.album.coverArtUrl ?? '',
    size: 0,
    contentType: 'audio/spotify',
    suffix: 'spotify',
    duration: track.durationSeconds,
    bitRate: 0,
    path: track.uri,
    discNumber: track.discNumber,
    created: new Date(0).toISOString(),
    albumId: track.album.uri,
    artistId,
    type: 'music',
    isVideo: false,
    bpm: 0,
    comment: '',
    sortName: track.title,
    mediaType: 'music',
    musicBrainzId: '',
    genres: [],
    replayGain: spotifyDefaultReplayGain,
    artists,
    displayArtist: artistName,
    albumArtists: track.album.artists.map((artist) => ({
      id: artist.uri || `spotify:artist:${artist.id}`,
      name: artist.name,
    })),
    displayAlbumArtist: track.album.artists.map((artist) => artist.name).join(', '),
  }
}

function sortSongsForArtist(songA: ISong, songB: ISong): number {
  const albumCompare = songA.album.localeCompare(songB.album)
  if (albumCompare !== 0) return albumCompare

  if (songA.discNumber !== songB.discNumber) {
    return songA.discNumber - songB.discNumber
  }

  if (songA.track !== songB.track) {
    return songA.track - songB.track
  }

  return songA.title.localeCompare(songB.title)
}

async function fetchNavidromeSongsPage(
  query: string,
  songOffset: number,
  songCount: number,
): Promise<ISong[]> {
  if (songCount <= 0) return []

  const response = await subsonic.search.get({
    artistCount: 0,
    albumCount: 0,
    query,
    songCount,
    songOffset,
  })

  return response?.song ?? []
}

async function resolveNavidromeSongCount(query: string): Promise<number> {
  const normalizedQuery = query.trim().toLowerCase()

  if (navidromeSongCountCache.has(normalizedQuery)) {
    return navidromeSongCountCache.get(normalizedQuery) ?? 0
  }

  if (normalizedQuery === '') {
    const storedSongCount = useAppStore.getState().data.songCount
    if (storedSongCount && storedSongCount > 0) {
      navidromeSongCountCache.set(normalizedQuery, storedSongCount)
      return storedSongCount
    }
  }

  const inFlight = navidromeSongCountInFlight.get(normalizedQuery)
  if (inFlight) return inFlight

  const countPromise = (async () => {
    let lowerBound = 0
    let upperBound = NAVIDROME_COUNT_PAGE_SIZE

    while (true) {
      const songs = await fetchNavidromeSongsPage(
        query,
        upperBound,
        NAVIDROME_COUNT_PAGE_SIZE,
      )

      if (songs.length < NAVIDROME_COUNT_PAGE_SIZE) break
      lowerBound = upperBound
      upperBound *= 2
    }

    while (lowerBound < upperBound) {
      const midpoint = Math.floor((lowerBound + upperBound) / 2)
      const songs = await fetchNavidromeSongsPage(
        query,
        midpoint,
        NAVIDROME_COUNT_PAGE_SIZE,
      )

      if (songs.length < NAVIDROME_COUNT_PAGE_SIZE) {
        upperBound = midpoint
      } else {
        lowerBound = midpoint + 1
      }
    }

    const tailOffset = lowerBound
    const tailSongs = await fetchNavidromeSongsPage(
      query,
      tailOffset,
      NAVIDROME_COUNT_PAGE_SIZE,
    )
    const total = tailOffset + tailSongs.length

    navidromeSongCountCache.set(normalizedQuery, total)

    if (normalizedQuery === '') {
      useAppStore.setState((state) => {
        state.data.songCount = total
      })
    }

    return total
  })()

  navidromeSongCountInFlight.set(normalizedQuery, countPromise)

  try {
    return await countPromise
  } finally {
    navidromeSongCountInFlight.delete(normalizedQuery)
  }
}

async function getLocalSongsPage(
  query: string,
  offset: number,
  limit: number,
): Promise<{ songs: ISong[]; totalCount: number }> {
  const localResult = query
    ? await searchTracksPage(query, offset, limit)
    : await getTracksPage(offset, limit)

  return {
    songs: localResult.tracks.map(convertLocalTrackToISong),
    totalCount: localResult.total,
  }
}

async function getLocalSongsCount(query: string): Promise<number> {
  if (query) {
    return searchTracksCount(query)
  }

  return getTracksCount()
}

export async function songsSearch(
  params: SongSearchParams,
): Promise<SongSearchResult> {
  const { source = 'all', query, songCount, songOffset } = params

  if (source === 'navidrome') {
    const songs = await fetchNavidromeSongsPage(query, songOffset, songCount)
    const totalCount =
      songOffset === 0 ? await resolveNavidromeSongCount(query) : undefined

    return {
      songs,
      nextOffset:
        totalCount !== undefined
          ? songOffset + songs.length < totalCount
            ? songOffset + songCount
            : null
          : songs.length >= songCount
            ? songOffset + songCount
            : null,
      totalCount,
    }
  }

  if (source === 'local') {
    const localPage = await getLocalSongsPage(query, songOffset, songCount)

    return {
      songs: localPage.songs,
      nextOffset:
        songOffset + localPage.songs.length < localPage.totalCount
          ? songOffset + songCount
          : null,
      totalCount: localPage.totalCount,
    }
  }

  if (source === 'spotify') {
    const spotifyPage = await spotifySearchTracks({
      query,
      limit: songCount,
      offset: songOffset,
    })

    const songs = spotifyPage.tracks.map(mapSpotifyTrackToISong)
    const totalCount = spotifyPage.totalCount

    return {
      songs,
      nextOffset:
        songOffset + songs.length < totalCount ? songOffset + songCount : null,
      totalCount,
    }
  }

  const [navidromeCount, localCount] = await Promise.all([
    resolveNavidromeSongCount(query),
    getLocalSongsCount(query),
  ])
  const totalCount = navidromeCount + localCount

  if (songOffset >= totalCount) {
    return {
      songs: [],
      nextOffset: null,
      totalCount,
    }
  }

  const navidromePageSize = Math.min(
    songCount,
    Math.max(0, navidromeCount - songOffset),
  )
  const navidromeSongs =
    navidromePageSize > 0
      ? await fetchNavidromeSongsPage(query, songOffset, navidromePageSize)
      : []

  const localPageOffset = Math.max(0, songOffset - navidromeCount)
  const localPageSize = Math.max(0, songCount - navidromeSongs.length)
  const localPage =
    localPageSize > 0
      ? await getLocalSongsPage(query, localPageOffset, localPageSize)
      : { songs: [], totalCount: localCount }

  const songs = [...navidromeSongs, ...localPage.songs]

  return {
    songs,
    nextOffset:
      songOffset + songs.length < totalCount ? songOffset + songCount : null,
    totalCount,
  }
}

export async function getArtistAllSongs(artistId: string) {
  if (artistId.startsWith('local-artist:')) {
    const tracks = await getAllTracks()
    const encodedArtistName = artistId.replace('local-artist:', '')
    const decodedArtistName = (() => {
      try {
        return decodeURIComponent(encodedArtistName)
      } catch {
        return encodedArtistName
      }
    })()
      .trim()
      .toLowerCase()

    const songs = tracks
      .map(convertLocalTrackToISong)
      .filter((song) => {
        const normalizedArtistId = song.artistId || createLocalArtistId(song.artist)
        if (normalizedArtistId === artistId) return true

        return song.artist.trim().toLowerCase() === decodedArtistName
      })
      .sort(sortSongsForArtist)

    return {
      songs,
      nextOffset: null,
      totalCount: songs.length,
    }
  }

  const artist = await subsonic.artists.getOne(artistId)

  if (!artist || !artist.album) {
    const fallbackSearch = await subsonic.search.get({
      query: artistId,
      songCount: 9999999,
      albumCount: 0,
      artistCount: 0,
    })

    const fallbackSongs = fallbackSearch?.song ?? []

    return {
      songs: fallbackSongs,
      nextOffset: null,
      totalCount: fallbackSongs.length,
    }
  }

  const results = await Promise.all(
    artist.album.map(({ id }) => subsonic.albums.getOne(id)),
  )

  const songs = results.flatMap((result) => {
    if (!result) return []

    return result.song
  })

  return {
    songs,
    nextOffset: null,
    totalCount: songs.length,
  }
}

export async function getFavoriteSongs() {
  const response = await subsonic.songs.getFavoriteSongs()

  if (!response || !response.song) return { songs: [] }

  return { songs: response.song }
}
