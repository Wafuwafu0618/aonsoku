import {
  convertLocalTrackToISong,
  createLocalArtistId,
  getAllTracks,
} from '@/local-library'
import { subsonic } from '@/service/subsonic'
import { Albums, DiscTitle } from '@/types/responses/album'
import { IArtist, IArtistInfo, ISimilarArtist } from '@/types/responses/artist'
import { ISong } from '@/types/responses/song'

export type ArtistSource = 'all' | 'navidrome' | 'local'

interface LocalArtistAggregate {
  artist: IArtist
  songs: ISong[]
}

interface LocalArtistCollection {
  list: ISimilarArtist[]
  byId: Map<string, LocalArtistAggregate>
}

interface LocalArtistAlbumAggregate {
  album: Albums
  songs: ISong[]
}

let localArtistCollectionInFlight: Promise<LocalArtistCollection> | null = null

function toMs(value?: string): number {
  if (!value) return 0

  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function decodeLocalArtistName(artistId: string): string {
  if (!artistId.startsWith('local-artist:')) return ''

  const encodedName = artistId.replace('local-artist:', '')
  try {
    return decodeURIComponent(encodedName)
  } catch {
    return encodedName
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

function createEmptyLocalAlbum(song: ISong): LocalArtistAlbumAggregate {
  const albumArtist = song.displayAlbumArtist || song.artist || 'Unknown Artist'
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

function buildLocalArtistAlbums(songs: ISong[]): Albums[] {
  const albumMap = new Map<string, LocalArtistAlbumAggregate>()

  for (const song of songs) {
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

  const albums: Albums[] = []
  for (const aggregate of albumMap.values()) {
    aggregate.album.discTitles = [...aggregate.album.discTitles].sort(
      (a: DiscTitle, b: DiscTitle) => a.disc - b.disc,
    )
    albums.push(aggregate.album)
  }

  return albums.sort((a, b) => a.name.localeCompare(b.name))
}

async function getLocalArtistCollection(): Promise<LocalArtistCollection> {
  if (localArtistCollectionInFlight) {
    return localArtistCollectionInFlight
  }

  localArtistCollectionInFlight = (async () => {
    const tracks = await getAllTracks()
    const map = new Map<string, LocalArtistAggregate>()

    for (const track of tracks) {
      const song = convertLocalTrackToISong(track)
      const artistName = song.artist || 'Unknown Artist'
      const artistId = song.artistId || createLocalArtistId(artistName)

      if (!map.has(artistId)) {
        map.set(artistId, {
          artist: {
            id: artistId,
            name: artistName,
            coverArt: song.coverArt || '',
            albumCount: 0,
            artistImageUrl: '',
            sortName: artistName,
            musicBrainzId: '',
            album: [],
          },
          songs: [],
        })
      }

      const aggregate = map.get(artistId)
      if (!aggregate) continue

      aggregate.songs.push(song)
      if (!aggregate.artist.coverArt && song.coverArt) {
        aggregate.artist.coverArt = song.coverArt
      }
    }

    const list: ISimilarArtist[] = []

    for (const [artistId, aggregate] of map.entries()) {
      const sortedSongs = [...aggregate.songs].sort(sortSongsForArtist)
      const albums = buildLocalArtistAlbums(sortedSongs)

      aggregate.artist.album = albums
      aggregate.artist.albumCount = albums.length
      aggregate.songs = sortedSongs

      list.push({
        id: artistId,
        name: aggregate.artist.name,
        albumCount: aggregate.artist.albumCount,
        coverArt: aggregate.artist.coverArt,
        artistImageUrl: '',
      })
    }

    list.sort((a, b) => a.name.localeCompare(b.name))

    return {
      list,
      byId: map,
    }
  })()

  try {
    return await localArtistCollectionInFlight
  } finally {
    localArtistCollectionInFlight = null
  }
}

export async function getArtists(source: ArtistSource = 'all') {
  if (source === 'navidrome') {
    return subsonic.artists.getAll()
  }

  if (source === 'local') {
    const local = await getLocalArtistCollection()
    return local.list
  }

  const [navidromeArtists, localArtists] = await Promise.all([
    subsonic.artists.getAll(),
    getLocalArtistCollection().then((collection) => collection.list),
  ])

  return [...navidromeArtists, ...localArtists].sort((a, b) =>
    a.name.localeCompare(b.name),
  )
}

export async function getArtistById(artistId: string): Promise<IArtist | null> {
  if (artistId.startsWith('local-artist:')) {
    const local = await getLocalArtistCollection()
    const aggregate = local.byId.get(artistId)

    if (aggregate) {
      return aggregate.artist
    }

    const artistName = decodeLocalArtistName(artistId)
    if (!artistName) return null

    return {
      id: artistId,
      name: artistName,
      coverArt: '',
      albumCount: 0,
      artistImageUrl: '',
      sortName: artistName,
      musicBrainzId: '',
      album: [],
    }
  }

  const artist = await subsonic.artists.getOne(artistId)
  return artist ?? null
}

export async function getArtistInfoById(
  artistId: string,
): Promise<IArtistInfo | null> {
  if (artistId.startsWith('local-artist:')) {
    return null
  }

  const info = await subsonic.artists.getInfo(artistId)
  return info ?? null
}

export async function getArtistTopSongsById(artistId: string): Promise<ISong[]> {
  if (artistId.startsWith('local-artist:')) {
    const local = await getLocalArtistCollection()
    return local.byId.get(artistId)?.songs ?? []
  }

  const artist = await subsonic.artists.getOne(artistId)
  if (!artist?.name) return []

  const topSongs = await subsonic.songs.getTopSongs(artist.name)
  return topSongs ?? []
}
