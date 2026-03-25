import { Play } from 'lucide-react'
import { useMemo } from 'react'
import { Button } from '@/app/components/ui/button'
import { useSearchAppleMusic } from '@/app/hooks/use-apple-music'
import { mapAppleMusicSongToAppSong } from '@/domain/mappers/apple-music'
import { useAppleMusicFavoriteGenres } from '@/store/app.store'
import { usePlayerActions } from '@/store/player.store'
import { AppleMusicSong } from '@/types/responses/apple-music'

// 複数のジャンル検索結果をマージするためのフック
function useMultiGenreSearch(genres: string[]) {
  // 各ジャンルで検索（最大3ジャンルまで）
  const searchQueries = genres.slice(0, 3)

  const results = searchQueries.map((genre) => {
    return useSearchAppleMusic(genre, ['songs'], genres.length > 0)
  })

  const isLoading = results.some((r) => r.isLoading)
  const isError = results.some((r) => r.isError)

  // 全ての検索結果をマージしてシャッフル
  const songs = useMemo(() => {
    if (isLoading) return []

    const allSongs: AppleMusicSong[] = []
    const seenIds = new Set<string>()

    results.forEach((result) => {
      if (result.data?.songs) {
        result.data.songs.forEach((song) => {
          if (!seenIds.has(song.id)) {
            seenIds.add(song.id)
            allSongs.push(song)
          }
        })
      }
    })

    // シャッフルして8曲選ぶ
    return allSongs.sort(() => Math.random() - 0.5).slice(0, 8)
  }, [results, isLoading])

  return { songs, isLoading, isError }
}

export function AppleMusicFavoriteGenrePicks() {
  const { setSongList } = usePlayerActions()
  const { genres: favoriteGenres } = useAppleMusicFavoriteGenres()

  const { songs: displaySongs, isLoading } = useMultiGenreSearch(favoriteGenres)

  // ローディング状態
  if (isLoading) {
    return (
      <section className="px-8 pt-6">
        <div className="mb-4">
          <h2 className="text-xl font-semibold tracking-tight">
            Picks for You
          </h2>
          <p className="text-sm text-muted-foreground">
            Loading recommendations...
          </p>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-[72px] rounded-lg bg-skeleton" />
          ))}
        </div>
      </section>
    )
  }

  // 常に表示（データがなくても）
  return (
    <section className="px-8 pt-6">
      <div className="mb-4">
        <h2 className="text-xl font-semibold tracking-tight">
          あなたへのおすすめ
        </h2>
        {favoriteGenres.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            お気に入りジャンル: {favoriteGenres.join(', ')}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            設定でお気に入りジャンルを選択すると、パーソナライズされたおすすめが表示されます
          </p>
        )}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {displaySongs.length > 0 ? (
          displaySongs.map((song) => (
            <div
              key={song.id}
              className="group relative overflow-hidden rounded-lg border border-white/10 bg-background/35 backdrop-blur-md transition-colors hover:border-white/20 hover:bg-background/45"
            >
              <div className="flex items-center gap-3 pr-16">
                <div className="h-[72px] w-[72px] shrink-0 overflow-hidden bg-skeleton">
                  {song.artworkUrl ? (
                    <img
                      src={song.artworkUrl}
                      alt={song.title}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="h-full w-full bg-skeleton" />
                  )}
                </div>

                <div className="min-w-0 py-2">
                  <p className="truncate text-sm font-semibold leading-5">
                    {song.title}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {song.artistName}
                  </p>
                </div>
              </div>

              <Button
                size="icon"
                variant="outline"
                className="absolute right-3 top-1/2 h-9 w-9 -translate-y-1/2 rounded-full border-white/25 bg-background/55 opacity-100 backdrop-blur-sm sm:opacity-0 sm:group-hover:opacity-100"
                onClick={() =>
                  setSongList([mapAppleMusicSongToAppSong(song)], 0)
                }
                aria-label={`Play ${song.title}`}
              >
                <Play className="h-4 w-4 fill-current" />
              </Button>
            </div>
          ))
        ) : (
          <div className="col-span-full text-center py-8 text-muted-foreground">
            <p>No songs found. Try selecting different genres in Settings.</p>
          </div>
        )}
      </div>
    </section>
  )
}
