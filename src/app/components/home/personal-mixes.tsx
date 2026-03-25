import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ImageLoader } from '@/app/components/image-loader'
import { Skeleton } from '@/app/components/ui/skeleton'
import { useGetMostPlayed } from '@/app/hooks/use-home'
import { getAlbumById } from '@/queries/albums'
import { ROUTES } from '@/routes/routesList'
import { useTheme } from '@/store/theme.store'
import { Theme } from '@/types/themeContext'
import { Albums } from '@/types/responses/album'
import { ISong } from '@/types/responses/song'
import { shuffleSongList } from '@/utils/songListFunctions'

const MIX_COLUMNS_DESKTOP = 4
const MIX_ROWS_DESKTOP = 6
const MIX_CARD_COUNT = MIX_COLUMNS_DESKTOP * MIX_ROWS_DESKTOP

type MixCard = {
  id: string
  label: string
  title: string
  description: string
  coverArt: string
  kind: 'artist' | 'genre'
  matchKey: string
  artistId?: string
}

type ArtistAggregate = {
  name: string
  id?: string
  count: number
  coverArt: string
}

type GenreAggregate = {
  name: string
  count: number
  coverArt: string
}

function normalize(value: string) {
  return value.trim().toLowerCase()
}

function resolveGenre(album: Albums): string {
  if (album.genre && album.genre.trim() !== '') return album.genre.trim()

  const fromGenres = album.genres?.[0]?.name ?? ''
  return fromGenres.trim()
}

function topArtists(albums: Albums[]): ArtistAggregate[] {
  const map = new Map<string, ArtistAggregate>()

  for (const album of albums) {
    const name = album.artist?.trim()
    if (!name) continue

    const key = album.artistId ? `id:${album.artistId}` : `name:${normalize(name)}`
    const current = map.get(key)
    if (current) {
      current.count += 1
      if (!current.coverArt && album.coverArt) current.coverArt = album.coverArt
      continue
    }

    map.set(key, {
      name,
      id: album.artistId,
      count: 1,
      coverArt: album.coverArt,
    })
  }

  return [...map.values()].sort((a, b) => b.count - a.count)
}

function topGenres(albums: Albums[]): GenreAggregate[] {
  const map = new Map<string, GenreAggregate>()

  for (const album of albums) {
    const genre = resolveGenre(album)
    if (!genre) continue

    const key = normalize(genre)
    const current = map.get(key)
    if (current) {
      current.count += 1
      if (!current.coverArt && album.coverArt) current.coverArt = album.coverArt
      continue
    }

    map.set(key, {
      name: genre,
      count: 1,
      coverArt: album.coverArt,
    })
  }

  return [...map.values()].sort((a, b) => b.count - a.count)
}

function buildMixCards(albums: Albums[]): MixCard[] {
  const artists = topArtists(albums)
  const genres = topGenres(albums)
  const frequentGenreKeys = new Set(genres.slice(0, 3).map((genre) => normalize(genre.name)))
  const lessPlayedGenres = [...genres]
    .reverse()
    .filter((genre) => !frequentGenreKeys.has(normalize(genre.name)))
  const cards: MixCard[] = []
  const cardSet = new Set<string>()
  let artistIndex = 0
  let genreIndex = 0
  let lessPlayedGenreIndex = 0

  function pushArtistMix() {
    const artist = artists[artistIndex]
    artistIndex += 1
    if (!artist) return

    const dedupeKey = artist.id
      ? `artist-id:${artist.id}`
      : `artist-name:${normalize(artist.name)}`

    if (cardSet.has(dedupeKey)) return
    if (!artist.coverArt || artist.coverArt.trim() === '') return

    cardSet.add(dedupeKey)
    cards.push({
      id: `artist-${artist.id ?? normalize(artist.name)}`,
      label: 'ARTIST MIX',
      title: `${artist.name} Mix`,
      description: 'ランダムミックス',
      coverArt: artist.coverArt,
      kind: 'artist',
      matchKey: normalize(artist.name),
      artistId: artist.id,
    })
  }

  function pushGenreMix() {
    const genre = genres[genreIndex]
    genreIndex += 1
    if (!genre) return

    const dedupeKey = `genre:${normalize(genre.name)}`
    if (cardSet.has(dedupeKey)) return
    if (!genre.coverArt || genre.coverArt.trim() === '') return

    cardSet.add(dedupeKey)
    cards.push({
      id: `genre-${normalize(genre.name)}`,
      label: 'GENRE MIX',
      title: `${genre.name} Mix`,
      description: 'ランダムミックス',
      coverArt: genre.coverArt,
      kind: 'genre',
      matchKey: normalize(genre.name),
    })
  }

  function pushLessPlayedGenreMix() {
    const genre = lessPlayedGenres[lessPlayedGenreIndex]
    lessPlayedGenreIndex += 1
    if (!genre) return

    const dedupeKey = `genre:${normalize(genre.name)}`
    if (cardSet.has(dedupeKey)) return
    if (!genre.coverArt || genre.coverArt.trim() === '') return

    cardSet.add(dedupeKey)
    cards.push({
      id: `less-genre-${normalize(genre.name)}`,
      label: 'DISCOVERY',
      title: `${genre.name} Mix`,
      description: '発見ミックス',
      coverArt: genre.coverArt,
      kind: 'genre',
      matchKey: normalize(genre.name),
    })
  }

  while (
    cards.length < MIX_CARD_COUNT &&
    (
      artistIndex < artists.length ||
      genreIndex < genres.length ||
      lessPlayedGenreIndex < lessPlayedGenres.length
    )
  ) {
    pushArtistMix()
    pushGenreMix()
    pushLessPlayedGenreMix()
    pushArtistMix()
  }

  return cards.slice(0, MIX_CARD_COUNT)
}

function MixCardSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 pb-6 md:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: MIX_CARD_COUNT }).map((_, index) => (
        <Skeleton key={index} className="h-[230px] rounded-xl" />
      ))}
    </div>
  )
}

export function PersonalMixes() {
  const { data, isLoading, isFetching } = useGetMostPlayed()
  const navigate = useNavigate()
  const { theme } = useTheme()
  const [preparingMixId, setPreparingMixId] = useState<string | null>(null)
  const sourceAlbums = data?.list ?? []
  const mixes = buildMixCards(sourceAlbums)
  const isBusy = isLoading || isFetching
  const useLightOverlay =
    theme === Theme.MinatoWave ||
    theme === Theme.Light ||
    theme === Theme.NightOwlLight ||
    theme === Theme.NoctisLilac ||
    theme === Theme.Achiever ||
    theme === Theme.TinaciousDesign

  if (!isBusy && mixes.length === 0) return null

  function albumMatchesMix(album: Albums, mix: MixCard) {
    if (mix.kind === 'artist') {
      if (mix.artistId) return album.artistId === mix.artistId
      return normalize(album.artist) === mix.matchKey
    }

    return normalize(resolveGenre(album)) === mix.matchKey
  }

  async function handlePlayMix(mix: MixCard) {
    if (preparingMixId) return
    setPreparingMixId(mix.id)

    try {
      const matchedAlbums = sourceAlbums.filter((album) => albumMatchesMix(album, mix))
      if (matchedAlbums.length === 0) return

      const selectedAlbums = shuffleSongList(matchedAlbums, 0, true).slice(0, 10)
      const albumResults = await Promise.all(
        selectedAlbums.map(async (album) => {
          try {
            return await getAlbumById(album.id)
          } catch {
            return null
          }
        }),
      )

      const songMap = new Map<string, ISong>()
      for (const result of albumResults) {
        for (const song of result?.song ?? []) {
          if (!songMap.has(song.id)) {
            songMap.set(song.id, song)
          }
        }
      }

      const songs = [...songMap.values()]
      if (songs.length === 0) return

      const mixedSongs = shuffleSongList(songs, 0, true).slice(0, 80)
      navigate(ROUTES.MIX.PAGE(mix.id), {
        state: {
          mixId: mix.id,
          title: mix.title,
          description: mix.description,
          coverArt: mix.coverArt,
          songs: mixedSongs,
        },
      })
    } finally {
      setPreparingMixId(null)
    }
  }

  return (
    <section className="pt-6">
      <div className="mb-4">
        <h3 className="text-xl font-semibold tracking-tight">あなた向けミックス</h3>
      </div>

      {isBusy && <MixCardSkeleton />}
      {!isBusy && mixes.length > 0 && (
        <div className="grid grid-cols-1 gap-4 pb-6 md:grid-cols-2 xl:grid-cols-4">
          {mixes.map((mix) => (
            <button
              type="button"
              key={mix.id}
              onClick={() => handlePlayMix(mix)}
              disabled={preparingMixId !== null}
              className="group relative block aspect-[4/5] min-h-[220px] overflow-hidden rounded-xl border border-white/10 bg-background/35 text-left backdrop-blur-md disabled:cursor-wait disabled:opacity-75"
            >
              <ImageLoader id={mix.coverArt} type="album" size={600}>
                {(src) => (
                  <img
                    src={src}
                    alt={mix.title}
                    className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                  />
                )}
              </ImageLoader>

              <div
                className={
                  useLightOverlay
                    ? 'absolute inset-0 bg-gradient-to-b from-white/78 via-white/46 to-white/86'
                    : 'absolute inset-0 bg-gradient-to-b from-black/75 via-black/35 to-black/90'
                }
              />

              <div className="relative z-10 flex h-full flex-col justify-between p-4">
                <div>
                  <span
                    className={
                      useLightOverlay
                        ? 'inline-flex rounded-full border border-black/15 bg-white/55 px-2 py-1 text-[11px] font-semibold tracking-wide text-black/80'
                        : 'inline-flex rounded-full border border-white/20 bg-black/25 px-2 py-1 text-[11px] font-semibold tracking-wide text-white/90'
                    }
                  >
                    {mix.label}
                  </span>
                  <h4
                    className={
                      useLightOverlay
                        ? 'mt-2 text-[20px] font-bold leading-tight text-black/90'
                        : 'mt-2 text-[20px] font-bold leading-tight text-white drop-shadow'
                    }
                  >
                    {mix.title}
                  </h4>
                </div>

                <p
                  className={
                    useLightOverlay
                      ? 'text-xs text-black/75 line-clamp-2'
                      : 'text-xs text-white/85 line-clamp-2'
                  }
                >
                  {preparingMixId === mix.id ? 'ミックスを作成中...' : mix.description}
                </p>
              </div>
            </button>
          ))}
        </div>
      )}
    </section>
  )
}
