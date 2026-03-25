import { Play } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Button } from '@/app/components/ui/button'
import { resolveAppleMusicAlbumDetailId } from '@/domain/mappers/apple-music'
import { useSearchAppleMusic } from '@/app/hooks/use-apple-music'
import { ROUTES } from '@/routes/routesList'
import { useAppleMusicFavoriteGenres } from '@/store/app.store'
import { usePlayerActions } from '@/store/player.store'
import { AppleMusicAlbum, AppleMusicSong } from '@/types/responses/apple-music'

// ジャンル集計用の型
type GenreAggregate = {
  name: string
  count: number
  coverArt?: string
}

// アーティスト集計用の型
type ArtistAggregate = {
  name: string
  count: number
  coverArt?: string
}

function normalize(value: string) {
  return value.trim().toLowerCase()
}

// ライブラリからジャンル頻度を分析
function analyzeGenres(songs: AppleMusicSong[]): GenreAggregate[] {
  const map = new Map<string, GenreAggregate>()

  for (const song of songs) {
    const genres = song.genreNames || []
    for (const genre of genres) {
      if (!genre) continue

      const key = normalize(genre)
      const current = map.get(key)
      if (current) {
        current.count += 1
        if (!current.coverArt && song.artworkUrl) {
          current.coverArt = song.artworkUrl
        }
        continue
      }

      map.set(key, {
        name: genre,
        count: 1,
        coverArt: song.artworkUrl,
      })
    }
  }

  return [...map.values()].sort((a, b) => b.count - a.count)
}

// ライブラリからアーティスト頻度を分析
function analyzeArtists(
  songs: AppleMusicSong[],
  albums: AppleMusicAlbum[],
): ArtistAggregate[] {
  const map = new Map<string, ArtistAggregate>()

  // 曲からアーティストを収集
  for (const song of songs) {
    const artist = song.artistName?.trim()
    if (!artist) continue

    const key = normalize(artist)
    const current = map.get(key)
    if (current) {
      current.count += 1
      if (!current.coverArt && song.artworkUrl) {
        current.coverArt = song.artworkUrl
      }
      continue
    }

    map.set(key, {
      name: artist,
      count: 1,
      coverArt: song.artworkUrl,
    })
  }

  // アルバムからもアーティストを収集（重複はカウント増加）
  for (const album of albums) {
    const artist = album.artistName?.trim()
    if (!artist) continue

    const key = normalize(artist)
    const current = map.get(key)
    if (current) {
      current.count += 3 // アルバムは重み付けを高く
      if (!current.coverArt && album.artworkUrl) {
        current.coverArt = album.artworkUrl
      }
      continue
    }

    map.set(key, {
      name: artist,
      count: 3,
      coverArt: album.artworkUrl,
    })
  }

  return [...map.values()].sort((a, b) => b.count - a.count)
}

interface AppleMusicGenreRecommendationsProps {
  songs?: AppleMusicSong[]
}

// 個別のジャンルセクションコンポーネント
function GenreSection({
  genre,
  onPlaySong,
}: {
  genre: GenreAggregate
  onPlaySong: (song: AppleMusicSong) => void
}) {
  const navigate = useNavigate()

  // カタログ全体からこのジャンルを検索
  const { data: searchData, isLoading } = useSearchAppleMusic(
    genre.name,
    ['songs', 'albums'],
    genre.name.length > 0,
  )

  const songs = searchData?.songs || []
  const albums = searchData?.albums || []

  // アルバムを優先して表示、その後曲を表示（ホームでは6件だけ）
  const displayItems = [...albums, ...songs].slice(0, 6)

  if (isLoading) {
    return (
      <div className="w-full flex flex-col mt-4">
        <div className="my-4 h-8 w-64 bg-skeleton rounded" />
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-2">
              <div className="aspect-square bg-skeleton rounded-md" />
              <div className="h-4 bg-skeleton rounded w-3/4" />
              <div className="h-3 bg-skeleton rounded w-1/2" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (displayItems.length === 0) return null

  return (
    <div className="w-full flex flex-col mt-4">
      <div className="my-4 flex justify-between items-center">
        <h3 className="scroll-m-20 text-2xl font-semibold tracking-tight">
          {genre.name}
        </h3>
        <button
          onClick={() => navigate(ROUTES.APPLE_MUSIC_GENRE.PAGE(genre.name))}
          className="text-sm text-muted-foreground hover:text-primary"
        >
          もっと見る
        </button>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-4">
        {displayItems.map((item) => {
          const isAlbum = 'trackCount' in item
          const id = item.id
          const title = isAlbum
            ? (item as AppleMusicAlbum).name
            : (item as AppleMusicSong).title
          const subtitle = isAlbum
            ? (item as AppleMusicAlbum).artistName
            : (item as AppleMusicSong).artistName
          const imageUrl = item.artworkUrl
          const link = isAlbum
            ? ROUTES.APPLE_MUSIC_ALBUM.PAGE(
              resolveAppleMusicAlbumDetailId(item as AppleMusicAlbum),
              genre.name,
            )
            : undefined

          const content = (
            <>
              <div className="relative aspect-square overflow-hidden rounded-md bg-skeleton">
                {imageUrl ? (
                  <img
                    src={imageUrl}
                    alt={title}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="h-full w-full bg-skeleton" />
                )}
                {'songs' in item && item.songs && item.songs.length > 0 && (
                  <Button
                    size="icon"
                    variant="outline"
                    className="absolute bottom-2 right-2 h-10 w-10 rounded-full border-white/25 bg-background/80 opacity-0 backdrop-blur-sm group-hover:opacity-100 transition-opacity"
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      const album = item as AppleMusicAlbum
                      if (album.songs && album.songs.length > 0) {
                        onPlaySong(album.songs[0])
                      }
                    }}
                    aria-label={`Play ${title}`}
                  >
                    <Play className="h-5 w-5 fill-current" />
                  </Button>
                )}
                {!isAlbum && (
                  <Button
                    size="icon"
                    variant="outline"
                    className="absolute bottom-2 right-2 h-10 w-10 rounded-full border-white/25 bg-background/80 opacity-0 backdrop-blur-sm group-hover:opacity-100 transition-opacity"
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      onPlaySong(item as AppleMusicSong)
                    }}
                    aria-label={`Play ${title}`}
                  >
                    <Play className="h-5 w-5 fill-current" />
                  </Button>
                )}
              </div>
              <p className="text-sm font-medium truncate hover:underline">
                {title}
              </p>
              <p className="text-xs text-muted-foreground truncate">
                {subtitle}
              </p>
            </>
          )

          if (link) {
            return (
              <Link key={id} to={link} className="group flex flex-col gap-2">
                {content}
              </Link>
            )
          }

          return (
            <div key={id} className="group flex flex-col gap-2">
              {content}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function AppleMusicGenreRecommendations({
  songs = [],
}: AppleMusicGenreRecommendationsProps) {
  const { setSongList } = usePlayerActions()
  const { genres: favoriteGenres } = useAppleMusicFavoriteGenres()

  // 設定からジャンルを取得（未設定の場合はライブラリ分析から）
  const genresToShow =
    favoriteGenres.length > 0
      ? favoriteGenres.map((name) => ({ name, count: 1 }))
      : analyzeGenres(songs).slice(0, 4)

  if (genresToShow.length === 0) return null

  const handlePlaySong = (song: AppleMusicSong) => {
    setSongList([song as any], 0)
  }

  return (
    <>
      {genresToShow.map((genre) => (
        <GenreSection
          key={genre.name}
          genre={genre}
          onPlaySong={handlePlaySong}
        />
      ))}
    </>
  )
}

interface AppleMusicPersonalMixesProps {
  songs?: AppleMusicSong[]
  albums?: AppleMusicAlbum[]
}

// 個別のアーティストミックスコンポーネント
function ArtistMixCard({
  artist,
  onPlayMix,
}: {
  artist: ArtistAggregate
  onPlayMix: (artist: ArtistAggregate) => void
}) {
  const [isLoading, setIsLoading] = useState(false)

  const handleClick = async () => {
    if (isLoading) return
    setIsLoading(true)
    await onPlayMix(artist)
    setIsLoading(false)
  }

  return (
    <div
      className="group flex flex-col gap-2 cursor-pointer"
      onClick={handleClick}
    >
      <div className="relative aspect-square overflow-hidden rounded-md bg-skeleton">
        {artist.coverArt ? (
          <img
            src={artist.coverArt}
            alt={artist.name}
            className="h-full w-full object-cover transition-transform group-hover:scale-105"
          />
        ) : (
          <div className="h-full w-full bg-skeleton" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />
        <div className="absolute bottom-0 left-0 right-0 p-3">
          <p className="text-white font-semibold text-sm truncate">
            {artist.name}
          </p>
          <p className="text-white/70 text-xs">ミックス</p>
        </div>
        <Button
          size="icon"
          variant="outline"
          className="absolute top-2 right-2 h-8 w-8 rounded-full border-white/25 bg-background/80 opacity-0 backdrop-blur-sm group-hover:opacity-100 transition-opacity"
          disabled={isLoading}
        >
          <Play className="h-4 w-4 fill-current" />
        </Button>
      </div>
      <p className="text-sm font-medium truncate">{artist.name}ミックス</p>
      <p className="text-xs text-muted-foreground truncate">
        {isLoading ? '読み込み中...' : 'シャッフル再生'}
      </p>
    </div>
  )
}

export function AppleMusicPersonalMixes({
  songs = [],
  albums = [],
}: AppleMusicPersonalMixesProps) {
  const { setSongList } = usePlayerActions()

  if (songs.length === 0 && albums.length === 0) return null

  const topArtists = analyzeArtists(songs, albums).slice(0, 4)

  if (topArtists.length === 0) return null

  const handlePlayMix = async (artist: ArtistAggregate) => {
    // カタログ全体からアーティストを検索
    try {
      const searchResult = await fetch(
        `/api/apple-music/search?query=${encodeURIComponent(artist.name)}&types=songs`,
      ).then((r) => r.json())

      const artistSongs = searchResult?.songs || []

      if (artistSongs.length > 0) {
        // シャッフルして最大50曲
        const shuffled = artistSongs
          .sort(() => Math.random() - 0.5)
          .slice(0, 50)
        setSongList(shuffled as any, 0)
      } else {
        // 検索結果がない場合はライブラリから
        const librarySongs = songs.filter(
          (song) => normalize(song.artistName) === normalize(artist.name),
        )
        if (librarySongs.length > 0) {
          setSongList(librarySongs as any, 0)
        }
      }
    } catch {
      // エラー時はライブラリから
      const librarySongs = songs.filter(
        (song) => normalize(song.artistName) === normalize(artist.name),
      )
      if (librarySongs.length > 0) {
        setSongList(librarySongs as any, 0)
      }
    }
  }

  return (
    <div className="w-full flex flex-col mt-4">
      <div className="my-4">
        <h3 className="scroll-m-20 text-2xl font-semibold tracking-tight">
          あなたのミックス
        </h3>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-4">
        {topArtists.map((artist) => (
          <ArtistMixCard
            key={artist.name}
            artist={artist}
            onPlayMix={handlePlayMix}
          />
        ))}
      </div>
    </div>
  )
}
