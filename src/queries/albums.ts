import {
  convertLocalTrackToISong,
  createLocalArtistId,
  getAllTracks,
} from '@/local-library'
import { AlbumListParams } from '@/service/albums'
import { subsonic } from '@/service/subsonic'
import { Albums, DiscTitle, SingleAlbum } from '@/types/responses/album'
import { ISong } from '@/types/responses/song'

const emptyResponse = { albums: [], nextOffset: null, albumsCount: 0 }
const NAVIDROME_ALBUM_SEARCH_PAGE_SIZE = 100

type AlbumSource = 'all' | 'navidrome' | 'local'

interface AlbumSearch {
  query: string
  count: number
  offset: number
  source?: AlbumSource
}

interface ArtistDiscographyOptions {
  source?: AlbumSource
  artistName?: string
  offset?: number
  count?: number
}

interface LocalAlbumAggregate {
  album: Albums
  songs: ISong[]
}

interface LocalAlbumCollection {
  albums: Albums[]
  songsByAlbumId: Map<string, ISong[]>
}

const navidromeAlbumSearchCountCache = new Map<string, number>()
const navidromeAlbumSearchCountInFlight = new Map<string, Promise<number>>()
let localAlbumCollectionInFlight: Promise<LocalAlbumCollection> | null = null

function toMs(value?: string): number {
  if (!value) return 0

  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function decodeId(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function sortSongsForAlbum(songA: ISong, songB: ISong): number {
  if (songA.discNumber !== songB.discNumber) {
    return songA.discNumber - songB.discNumber
  }

  if (songA.track !== songB.track) {
    return songA.track - songB.track
  }

  return songA.title.localeCompare(songB.title)
}

function getAlbumPrimaryArtist(song: ISong): string {
  return song.displayAlbumArtist || song.artist || 'Unknown Artist'
}

function createEmptyLocalAlbum(song: ISong): LocalAlbumAggregate {
  const albumArtist = getAlbumPrimaryArtist(song)
  const artistId =
    song.albumArtists?.[0]?.id || song.artistId || createLocalArtistId(albumArtist)
  const createdMs = toMs(song.created) || Date.now()

  return {
    album: {
      id: song.albumId,
      name: song.album || 'Unknown Album',
      artist: albumArtist,
      artistId,
      coverArt: song.coverArt || '',
      songCount: 0,
      duration: 0,
      playCount: 0,
      created: new Date(createdMs).toISOString(),
      year: song.year || undefined,
      genre: song.genre || '',
      userRating: 0,
      genres: song.genre ? [{ name: song.genre }] : [],
      musicBrainzId: '',
      isCompilation: false,
      sortName: song.album || 'Unknown Album',
      discTitles: [],
      artists: [{ id: artistId, name: albumArtist }],
      displayArtist: albumArtist,
    },
    songs: [],
  }
}

function hashString(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i)
    hash |= 0
  }

  return hash
}

function sortLocalAlbumsByFilter(
  albums: Albums[],
  params: Required<AlbumListParams>,
): Albums[] {
  const list = [...albums]

  switch (params.type) {
    case 'alphabeticalByName':
      return list.sort((a, b) => a.name.localeCompare(b.name))
    case 'alphabeticalByArtist':
      return list.sort((a, b) => {
        const artistCompare = a.artist.localeCompare(b.artist)
        if (artistCompare !== 0) return artistCompare
        return a.name.localeCompare(b.name)
      })
    case 'byYear': {
      const descending = Number(params.fromYear) > Number(params.toYear)
      return list.sort((a, b) => {
        const yearA = a.year ?? 0
        const yearB = b.year ?? 0
        if (yearA !== yearB) {
          return descending ? yearB - yearA : yearA - yearB
        }
        return a.name.localeCompare(b.name)
      })
    }
    case 'random':
      return list.sort((a, b) => hashString(a.id) - hashString(b.id))
    case 'starred':
      return list.filter((album) => typeof album.starred === 'string')
    case 'frequent':
      return list.sort((a, b) => (b.playCount ?? 0) - (a.playCount ?? 0))
    case 'recent':
    case 'newest':
    default:
      return list.sort((a, b) => toMs(b.created) - toMs(a.created))
  }
}

function filterLocalAlbumsByParams(
  albums: Albums[],
  params: Required<AlbumListParams>,
  query?: string,
): Albums[] {
  let filtered = [...albums]

  if (query && query.trim() !== '') {
    const normalizedQuery = query.trim().toLowerCase()
    filtered = filtered.filter((album) => {
      return (
        album.name.toLowerCase().includes(normalizedQuery) ||
        album.artist.toLowerCase().includes(normalizedQuery)
      )
    })
  }

  if (params.type === 'byGenre' && params.genre) {
    const normalizedGenre = params.genre.toLowerCase()
    filtered = filtered.filter((album) => {
      const genreMatch = album.genre.toLowerCase() === normalizedGenre
      const genreListMatch = album.genres.some(
        (genre) => genre.name.toLowerCase() === normalizedGenre,
      )

      return genreMatch || genreListMatch
    })
  }

  if (params.type === 'byYear') {
    const from = Number(params.fromYear)
    const to = Number(params.toYear)
    const minYear = Math.min(from, to)
    const maxYear = Math.max(from, to)

    filtered = filtered.filter((album) => {
      if (!album.year) return false
      return album.year >= minYear && album.year <= maxYear
    })
  }

  return sortLocalAlbumsByFilter(filtered, params)
}

async function getLocalAlbumCollection(): Promise<LocalAlbumCollection> {
  if (localAlbumCollectionInFlight) {
    return localAlbumCollectionInFlight
  }

  localAlbumCollectionInFlight = (async () => {
    const tracks = await getAllTracks()
    const albumMap = new Map<string, LocalAlbumAggregate>()

    for (const track of tracks) {
      const song = convertLocalTrackToISong(track)
      if (!song.albumId) continue

      if (!albumMap.has(song.albumId)) {
        albumMap.set(song.albumId, createEmptyLocalAlbum(song))
      }

      const aggregate = albumMap.get(song.albumId)
      if (!aggregate) continue

      aggregate.songs.push(song)
      aggregate.album.songCount += 1
      aggregate.album.duration += song.duration || 0

      if (!aggregate.album.coverArt && song.coverArt) {
        aggregate.album.coverArt = song.coverArt
      }

      if (!aggregate.album.genre && song.genre) {
        aggregate.album.genre = song.genre
      }

      if (song.genre) {
        const hasGenre = aggregate.album.genres.some(
          (genre) => genre.name === song.genre,
        )
        if (!hasGenre) {
          aggregate.album.genres.push({ name: song.genre })
        }
      }

      if ((song.year ?? 0) > (aggregate.album.year ?? 0)) {
        aggregate.album.year = song.year
      }

      const currentCreated = toMs(aggregate.album.created)
      const songCreated = toMs(song.created)
      if (songCreated > currentCreated) {
        aggregate.album.created = new Date(songCreated).toISOString()
      }

      if (song.discNumber > 0) {
        const hasDisc = aggregate.album.discTitles.some(
          (disc) => disc.disc === song.discNumber,
        )
        if (!hasDisc) {
          aggregate.album.discTitles.push({ disc: song.discNumber })
        }
      }
    }

    const songsByAlbumId = new Map<string, ISong[]>()
    const albums: Albums[] = []

    for (const [albumId, aggregate] of albumMap.entries()) {
      const sortedSongs = aggregate.songs.sort(sortSongsForAlbum)
      songsByAlbumId.set(albumId, sortedSongs)

      aggregate.album.discTitles = [...aggregate.album.discTitles].sort(
        (a: DiscTitle, b: DiscTitle) => a.disc - b.disc,
      )
      albums.push(aggregate.album)
    }

    return {
      albums,
      songsByAlbumId,
    }
  })()

  try {
    return await localAlbumCollectionInFlight
  } finally {
    localAlbumCollectionInFlight = null
  }
}

async function getLocalAlbumById(albumId: string): Promise<SingleAlbum | null> {
  const { albums, songsByAlbumId } = await getLocalAlbumCollection()

  const normalizedRequestedId = decodeId(albumId)
  const album = albums.find((item) => {
    if (item.id === albumId) return true

    return decodeId(item.id) === normalizedRequestedId
  })
  if (!album) return null

  const songs = songsByAlbumId.get(album.id) ?? []

  return {
    ...album,
    song: songs,
  }
}

async function fetchLocalAlbumsPage(params: {
  offset: number
  count: number
  query?: string
  listParams: Required<AlbumListParams>
}) {
  const { albums } = await getLocalAlbumCollection()
  const filtered = filterLocalAlbumsByParams(
    albums,
    params.listParams,
    params.query,
  )

  const page = filtered.slice(params.offset, params.offset + params.count)
  const nextOffset =
    params.offset + page.length < filtered.length
      ? params.offset + params.count
      : null

  return {
    albums: page,
    nextOffset,
    albumsCount: filtered.length,
  }
}

async function fetchNavidromeAlbumSearchPage(
  query: string,
  offset: number,
  count: number,
): Promise<Albums[]> {
  if (count <= 0) return []

  const response = await subsonic.search.get({
    query,
    songCount: 0,
    artistCount: 0,
    albumCount: count,
    albumOffset: offset,
  })

  return response?.album ?? []
}

async function resolveNavidromeAlbumSearchCount(query: string): Promise<number> {
  const normalizedQuery = query.trim().toLowerCase()

  if (navidromeAlbumSearchCountCache.has(normalizedQuery)) {
    return navidromeAlbumSearchCountCache.get(normalizedQuery) ?? 0
  }

  const inFlight = navidromeAlbumSearchCountInFlight.get(normalizedQuery)
  if (inFlight) return inFlight

  const promise = (async () => {
    let lowerBound = 0
    let upperBound = NAVIDROME_ALBUM_SEARCH_PAGE_SIZE

    while (true) {
      const albums = await fetchNavidromeAlbumSearchPage(
        query,
        upperBound,
        NAVIDROME_ALBUM_SEARCH_PAGE_SIZE,
      )

      if (albums.length < NAVIDROME_ALBUM_SEARCH_PAGE_SIZE) break
      lowerBound = upperBound
      upperBound *= 2
    }

    while (lowerBound < upperBound) {
      const midpoint = Math.floor((lowerBound + upperBound) / 2)
      const albums = await fetchNavidromeAlbumSearchPage(
        query,
        midpoint,
        NAVIDROME_ALBUM_SEARCH_PAGE_SIZE,
      )

      if (albums.length < NAVIDROME_ALBUM_SEARCH_PAGE_SIZE) {
        upperBound = midpoint
      } else {
        lowerBound = midpoint + 1
      }
    }

    const tailOffset = lowerBound
    const tailAlbums = await fetchNavidromeAlbumSearchPage(
      query,
      tailOffset,
      NAVIDROME_ALBUM_SEARCH_PAGE_SIZE,
    )

    const total = tailOffset + tailAlbums.length
    navidromeAlbumSearchCountCache.set(normalizedQuery, total)
    return total
  })()

  navidromeAlbumSearchCountInFlight.set(normalizedQuery, promise)

  try {
    return await promise
  } finally {
    navidromeAlbumSearchCountInFlight.delete(normalizedQuery)
  }
}

function mergeAlbumPages(
  offset: number,
  count: number,
  primaryAlbums: Albums[],
  primaryCount: number,
  secondaryAlbums: Albums[],
  secondaryCount: number,
) {
  const mergedAlbums = [...primaryAlbums, ...secondaryAlbums]
  const totalCount = primaryCount + secondaryCount

  return {
    albums: mergedAlbums,
    nextOffset:
      offset + mergedAlbums.length < totalCount ? offset + count : null,
    albumsCount: totalCount,
  }
}

async function getLocalDiscography(
  artistName: string,
  offset: number,
  count: number,
) {
  const { albums } = await getLocalAlbumCollection()
  const normalizedArtistName = artistName.trim().toLowerCase()

  const filtered = albums.filter(
    (album) => album.artist.toLowerCase() === normalizedArtistName,
  )
  const sorted = filtered.sort((a, b) => a.name.localeCompare(b.name))
  const page = sorted.slice(offset, offset + count)

  return {
    albums: page,
    nextOffset: offset + page.length < sorted.length ? offset + count : null,
    albumsCount: sorted.length,
  }
}

export async function getArtistDiscography(
  artistId: string,
  options: ArtistDiscographyOptions = {},
) {
  const source = options.source ?? 'navidrome'
  const offset = options.offset ?? 0
  const count = options.count ?? Number.MAX_SAFE_INTEGER
  const isLocalArtist = artistId.startsWith('local-artist:')
  const artistName =
    options.artistName ||
    decodeURIComponent(artistId.split(':').slice(1).join(':')) ||
    ''

  if (source === 'local' || (isLocalArtist && source !== 'navidrome')) {
    return getLocalDiscography(artistName, offset, count)
  }

  if (isLocalArtist) {
    return emptyResponse
  }

  const artist = await subsonic.artists.getOne(artistId)
  const navidromeAlbums = artist?.album ?? []
  const sortedNavidromeAlbums = navidromeAlbums.sort((a, b) =>
    a.name.localeCompare(b.name),
  )
  const navidromePage = sortedNavidromeAlbums.slice(offset, offset + count)
  const navidromeResponse = {
    albums: navidromePage,
    nextOffset:
      offset + navidromePage.length < sortedNavidromeAlbums.length
        ? offset + count
        : null,
    albumsCount: sortedNavidromeAlbums.length,
  }

  if (source === 'navidrome') {
    return navidromeResponse
  }

  const localOffset = Math.max(0, offset - navidromeResponse.albumsCount)
  const localCount = Math.max(0, count - navidromePage.length)
  const localResponse =
    localCount > 0
      ? await getLocalDiscography(artistName, localOffset, localCount)
      : { albums: [], albumsCount: 0, nextOffset: null }

  return mergeAlbumPages(
    offset,
    count,
    navidromePage,
    navidromeResponse.albumsCount,
    localResponse.albums,
    localResponse.albumsCount,
  )
}

export async function albumSearch({
  query,
  count,
  offset,
  source = 'all',
}: AlbumSearch) {
  if (source === 'local') {
    return fetchLocalAlbumsPage({
      offset,
      count,
      query,
      listParams: {
        type: 'search',
        size: count,
        offset,
        fromYear: '0001',
        toYear: new Date().getFullYear().toString(),
        genre: '',
      },
    })
  }

  const navidromeAlbums = await fetchNavidromeAlbumSearchPage(query, offset, count)
  const navidromeCount = await resolveNavidromeAlbumSearchCount(query)

  if (source === 'navidrome') {
    return {
      albums: navidromeAlbums,
      nextOffset:
        offset + navidromeAlbums.length < navidromeCount ? offset + count : null,
      albumsCount: navidromeCount,
    }
  }

  const localOffset = Math.max(0, offset - navidromeCount)
  const localCount = Math.max(0, count - navidromeAlbums.length)
  const localResponse =
    localCount > 0
      ? await fetchLocalAlbumsPage({
          offset: localOffset,
          count: localCount,
          query,
          listParams: {
            type: 'search',
            size: localCount,
            offset: localOffset,
            fromYear: '0001',
            toYear: new Date().getFullYear().toString(),
            genre: '',
          },
        })
      : { albums: [], albumsCount: 0, nextOffset: null }

  return mergeAlbumPages(
    offset,
    count,
    navidromeAlbums,
    navidromeCount,
    localResponse.albums,
    localResponse.albumsCount,
  )
}

export async function getAlbumList(
  params: Required<AlbumListParams> & { source?: AlbumSource },
) {
  const { source = 'all' } = params

  if (source === 'local') {
    return fetchLocalAlbumsPage({
      offset: params.offset,
      count: params.size,
      listParams: params,
    })
  }

  const navidromeResponse = await subsonic.albums.getAlbumList(params)
  const navidromeAlbums = navidromeResponse?.list ?? []
  const navidromeCount = navidromeResponse?.albumsCount ?? 0

  if (source === 'navidrome') {
    return {
      albums: navidromeAlbums,
      nextOffset:
        params.offset + navidromeAlbums.length < navidromeCount
          ? params.offset + params.size
          : null,
      albumsCount: navidromeCount,
    }
  }

  const localOffset = Math.max(0, params.offset - navidromeCount)
  const localCount = Math.max(0, params.size - navidromeAlbums.length)
  const localResponse =
    localCount > 0
      ? await fetchLocalAlbumsPage({
          offset: localOffset,
          count: localCount,
          listParams: params,
        })
      : { albums: [], albumsCount: 0, nextOffset: null }

  return mergeAlbumPages(
    params.offset,
    params.size,
    navidromeAlbums,
    navidromeCount,
    localResponse.albums,
    localResponse.albumsCount,
  )
}

export async function getAlbumById(albumId: string): Promise<SingleAlbum | null> {
  if (albumId.startsWith('local-album:')) {
    return getLocalAlbumById(albumId)
  }

  const album = await subsonic.albums.getOne(albumId)
  return album ?? null
}

export async function getLocalGenreAlbums(
  genre: string,
  size = 16,
): Promise<{ list: Albums[]; albumsCount: number }> {
  const localResponse = await fetchLocalAlbumsPage({
    offset: 0,
    count: size,
    listParams: {
      type: 'byGenre',
      size,
      offset: 0,
      fromYear: '0001',
      toYear: new Date().getFullYear().toString(),
      genre,
    },
  })

  return {
    list: localResponse.albums,
    albumsCount: localResponse.albumsCount,
  }
}

export { emptyResponse }
