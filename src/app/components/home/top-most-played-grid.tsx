import { Play } from 'lucide-react'
import { Link } from 'react-router-dom'
import { ImageLoader } from '@/app/components/image-loader'
import { Button } from '@/app/components/ui/button'
import { Skeleton } from '@/app/components/ui/skeleton'
import { getAlbumById } from '@/queries/albums'
import { ROUTES } from '@/routes/routesList'
import { usePlayerActions } from '@/store/player.store'
import { Albums } from '@/types/responses/album'
import { useGetMostPlayed } from '@/app/hooks/use-home'

const TOP_MOST_PLAYED_LIMIT = 8

function MostPlayedGridFallback() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: TOP_MOST_PLAYED_LIMIT }).map((_, index) => (
        <Skeleton key={index} className="h-[72px] rounded-lg" />
      ))}
    </div>
  )
}

function MostPlayedCard({ album }: { album: Albums }) {
  const { setSongList } = usePlayerActions()

  async function handlePlayAlbum() {
    const response = await getAlbumById(album.id)
    if (!response) return

    setSongList(response.song, 0)
  }

  return (
    <div className="group relative overflow-hidden rounded-lg border border-white/10 bg-background/35 backdrop-blur-md transition-colors hover:border-white/20 hover:bg-background/45">
      <Link to={ROUTES.ALBUM.PAGE(album.id)} className="flex items-center gap-3 pr-16">
        <div className="h-[72px] w-[72px] shrink-0 overflow-hidden bg-skeleton">
          <ImageLoader id={album.coverArt} type="album">
            {(src) => <img src={src} alt={album.name} className="h-full w-full object-cover" />}
          </ImageLoader>
        </div>

        <div className="min-w-0 py-2">
          <p className="truncate text-sm font-semibold leading-5">{album.name}</p>
          <p className="truncate text-xs text-muted-foreground">{album.artist}</p>
        </div>
      </Link>

      <Button
        size="icon"
        variant="outline"
        className="absolute right-3 top-1/2 h-9 w-9 -translate-y-1/2 rounded-full border-white/25 bg-background/55 opacity-100 backdrop-blur-sm sm:opacity-0 sm:group-hover:opacity-100"
        onClick={handlePlayAlbum}
        aria-label={`Play ${album.name}`}
      >
        <Play className="h-4 w-4 fill-current" />
      </Button>
    </div>
  )
}

export function TopMostPlayedGrid() {
  const { data, isLoading, isFetching } = useGetMostPlayed()

  const albums = data?.list?.slice(0, TOP_MOST_PLAYED_LIMIT) ?? []
  const hasAlbums = albums.length > 0
  const isBusy = isLoading || isFetching

  if (!isBusy && !hasAlbums) return null

  return (
    <section className="px-8 pt-6">
      {isBusy && <MostPlayedGridFallback />}
      {!isBusy && hasAlbums && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {albums.map((album) => (
            <MostPlayedCard key={album.id} album={album} />
          ))}
        </div>
      )}
    </section>
  )
}
