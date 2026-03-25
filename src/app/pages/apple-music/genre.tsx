import { Play } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import { Button } from '@/app/components/ui/button'
import {
  mapAppleMusicSongToAppSong,
  mapAppleMusicSongsToAppSongs,
  resolveAppleMusicAlbumDetailId,
} from '@/domain/mappers/apple-music'
import { useSearchAppleMusic } from '@/app/hooks/use-apple-music'
import { ROUTES } from '@/routes/routesList'
import { usePlayerActions } from '@/store/player.store'
import { AppleMusicAlbum, AppleMusicSong } from '@/types/responses/apple-music'

export default function AppleMusicGenrePage() {
  const { genre } = useParams<{ genre: string }>()
  const { setSongList } = usePlayerActions()

  const {
    data: searchData,
    isLoading,
  } = useSearchAppleMusic(genre || '', ['songs', 'albums'], !!genre)

  const songs = searchData?.songs || []
  const albums = searchData?.albums || []

  if (isLoading) {
    return (
      <div className="w-full h-full px-8 py-6">
        <h1 className="text-2xl font-bold mb-6">{genre}</h1>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-4">
          {Array.from({ length: 12 }).map((_, i) => (
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

  const allItems = [...albums, ...songs]

  return (
    <div className="w-full h-full px-8 py-6 overflow-auto">
      <div className="mb-6">
        <Link
          to={ROUTES.LIBRARY.HOME}
          className="text-sm text-muted-foreground hover:text-primary mb-2 inline-block"
        >
          ← ホームに戻る
        </Link>
        <h1 className="text-2xl font-bold">{genre}</h1>
        <p className="text-muted-foreground">{allItems.length} 件の結果</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-4">
        {allItems.map((item) => {
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
              genre,
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
                      setSongList(
                        mapAppleMusicSongsToAppSongs(
                          (item as AppleMusicAlbum).songs,
                        ),
                        0,
                      )
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
                      setSongList(
                        [mapAppleMusicSongToAppSong(item as AppleMusicSong)],
                        0,
                      )
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
