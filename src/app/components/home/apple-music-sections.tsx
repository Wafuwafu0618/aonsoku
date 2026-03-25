import { Play } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button } from '@/app/components/ui/button'
import { resolveAppleMusicAlbumDetailId } from '@/domain/mappers/apple-music'
import { ROUTES } from '@/routes/routesList'
import { usePlayerActions } from '@/store/player.store'
import {
  AppleMusicAlbum,
  AppleMusicPlaylist,
  AppleMusicSong,
} from '@/types/responses/apple-music'

interface AppleMusicNewReleasesProps {
  albums?: AppleMusicAlbum[]
}

export function AppleMusicNewReleases({ albums }: AppleMusicNewReleasesProps) {
  const { setSongList } = usePlayerActions()

  if (!albums || albums.length === 0) return null

  return (
    <section className="px-8 pt-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {albums.slice(0, 8).map((album) => (
          <div
            key={album.id}
            className="group relative overflow-hidden rounded-lg border border-white/10 bg-background/35 backdrop-blur-md transition-colors hover:border-white/20 hover:bg-background/45"
          >
            <Link
              to={ROUTES.APPLE_MUSIC_ALBUM.PAGE(
                resolveAppleMusicAlbumDetailId(album),
              )}
              className="flex items-center gap-3 pr-16"
            >
              <div className="h-[72px] w-[72px] shrink-0 overflow-hidden bg-skeleton">
                {album.artworkUrl ? (
                  <img
                    src={album.artworkUrl}
                    alt={album.name}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="h-full w-full bg-skeleton" />
                )}
              </div>

              <div className="min-w-0 py-2">
                <p className="truncate text-sm font-semibold leading-5">
                  {album.name}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {album.artistName}
                </p>
              </div>
            </Link>

            <Button
              size="icon"
              variant="outline"
              className="absolute right-3 top-1/2 h-9 w-9 -translate-y-1/2 rounded-full border-white/25 bg-background/55 opacity-100 backdrop-blur-sm sm:opacity-0 sm:group-hover:opacity-100"
              onClick={() => {
                if (album.songs?.length > 0) {
                  setSongList(album.songs as any, 0)
                }
              }}
              aria-label={`Play ${album.name}`}
            >
              <Play className="h-4 w-4 fill-current" />
            </Button>
          </div>
        ))}
      </div>
    </section>
  )
}

interface AppleMusicTopChartsProps {
  songs?: AppleMusicSong[]
  albums?: AppleMusicAlbum[]
  playlists?: AppleMusicPlaylist[]
}

export function AppleMusicTopCharts({
  songs,
  albums,
  playlists,
}: AppleMusicTopChartsProps) {
  const { setSongList } = usePlayerActions()

  return (
    <>
      {songs && songs.length > 0 && (
        <AppleMusicCarouselSection
          title="トップソング"
          items={songs.slice(0, 10).map((song) => ({
            id: song.id,
            title: song.title,
            subtitle: song.artistName,
            imageUrl: song.artworkUrl,
            onPlay: () => setSongList([song as any], 0),
          }))}
        />
      )}

      {albums && albums.length > 0 && (
        <AppleMusicCarouselSection
          title="トップアルバム"
          items={albums.slice(0, 10).map((album) => ({
            id: album.id,
            title: album.name,
            subtitle: album.artistName,
            imageUrl: album.artworkUrl,
            link: ROUTES.APPLE_MUSIC_ALBUM.PAGE(
              resolveAppleMusicAlbumDetailId(album),
            ),
            onPlay: album.songs?.length
              ? () => setSongList(album.songs as any, 0)
              : undefined,
          }))}
        />
      )}

      {playlists && playlists.length > 0 && (
        <AppleMusicCarouselSection
          title="トッププレイリスト"
          items={playlists.slice(0, 10).map((playlist) => ({
            id: playlist.id,
            title: playlist.name,
            subtitle: playlist.curatorName || 'Apple Music',
            imageUrl: playlist.artworkUrl,
            link: ROUTES.PLAYLIST.PAGE(playlist.id),
            onPlay: playlist.songs?.length
              ? () => setSongList(playlist.songs as any, 0)
              : undefined,
          }))}
        />
      )}
    </>
  )
}

interface AppleMusicCarouselItem {
  id: string
  title: string
  subtitle: string
  imageUrl?: string
  link?: string
  onPlay?: () => void
}

interface AppleMusicCarouselSectionProps {
  title: string
  items: AppleMusicCarouselItem[]
}

function AppleMusicCarouselSection({
  title,
  items,
}: AppleMusicCarouselSectionProps) {
  return (
    <div className="w-full flex flex-col mt-4">
      <div className="my-4 flex justify-between items-center">
        <h3 className="scroll-m-20 text-2xl font-semibold tracking-tight">
          {title}
        </h3>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-4">
        {items.map((item) => (
          <div key={item.id} className="group flex flex-col gap-2">
            <div className="relative aspect-square overflow-hidden rounded-md bg-skeleton">
              {item.link ? (
                <Link to={item.link} className="block h-full w-full">
                  {item.imageUrl ? (
                    <img
                      src={item.imageUrl}
                      alt={item.title}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="h-full w-full bg-skeleton" />
                  )}
                </Link>
              ) : (
                <>
                  {item.imageUrl ? (
                    <img
                      src={item.imageUrl}
                      alt={item.title}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="h-full w-full bg-skeleton" />
                  )}
                </>
              )}
              {item.onPlay && (
                <Button
                  size="icon"
                  variant="outline"
                  className="absolute bottom-2 right-2 z-10 h-10 w-10 rounded-full border-white/25 bg-background/80 opacity-0 backdrop-blur-sm group-hover:opacity-100 transition-opacity"
                  onClick={item.onPlay}
                  aria-label={`Play ${item.title}`}
                >
                  <Play className="h-5 w-5 fill-current" />
                </Button>
              )}
            </div>
            {item.link ? (
              <Link to={item.link} className="hover:underline">
                <p className="text-sm font-medium truncate">{item.title}</p>
              </Link>
            ) : (
              <p className="text-sm font-medium truncate">{item.title}</p>
            )}
            <p className="text-xs text-muted-foreground truncate">
              {item.subtitle}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}

interface AppleMusicRecentlyAddedProps {
  albums?: AppleMusicAlbum[]
}

export function AppleMusicRecentlyAdded({
  albums,
}: AppleMusicRecentlyAddedProps) {
  const { setSongList } = usePlayerActions()

  if (!albums || albums.length === 0) return null

  return (
    <div className="w-full flex flex-col mt-4">
      <div className="my-4 flex justify-between items-center">
        <h3 className="scroll-m-20 text-2xl font-semibold tracking-tight">
          最近追加されたアルバム
        </h3>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-4">
        {albums.slice(0, 12).map((album) => (
          <div key={album.id} className="group flex flex-col gap-2">
            <div className="relative aspect-square overflow-hidden rounded-md bg-skeleton">
              <Link
                to={ROUTES.APPLE_MUSIC_ALBUM.PAGE(
                  resolveAppleMusicAlbumDetailId(album),
                )}
                className="block h-full w-full"
              >
                {album.artworkUrl ? (
                  <img
                    src={album.artworkUrl}
                    alt={album.name}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="h-full w-full bg-skeleton" />
                )}
              </Link>
              {album.songs?.length > 0 && (
                <Button
                  size="icon"
                  variant="outline"
                  className="absolute bottom-2 right-2 z-10 h-10 w-10 rounded-full border-white/25 bg-background/80 opacity-0 backdrop-blur-sm group-hover:opacity-100 transition-opacity"
                  onClick={() => setSongList(album.songs as any, 0)}
                  aria-label={`Play ${album.name}`}
                >
                  <Play className="h-5 w-5 fill-current" />
                </Button>
              )}
            </div>
            <Link
              to={ROUTES.APPLE_MUSIC_ALBUM.PAGE(
                resolveAppleMusicAlbumDetailId(album),
              )}
              className="hover:underline"
            >
              <p className="text-sm font-medium truncate">{album.name}</p>
            </Link>
            <p className="text-xs text-muted-foreground truncate">
              {album.artistName}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}

interface AppleMusicBrowsePlaylistsProps {
  playlists?: AppleMusicPlaylist[]
}

export function AppleMusicBrowsePlaylists({
  playlists,
}: AppleMusicBrowsePlaylistsProps) {
  const { setSongList } = usePlayerActions()

  if (!playlists || playlists.length === 0) return null

  return (
    <div className="w-full flex flex-col mt-4">
      <div className="my-4 flex justify-between items-center">
        <h3 className="scroll-m-20 text-2xl font-semibold tracking-tight">
          プレイリストを探す
        </h3>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-4">
        {playlists.slice(0, 12).map((playlist) => (
          <div key={playlist.id} className="group flex flex-col gap-2">
            <div className="relative aspect-square overflow-hidden rounded-md bg-skeleton">
              {playlist.artworkUrl ? (
                <img
                  src={playlist.artworkUrl}
                  alt={playlist.name}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="h-full w-full bg-skeleton" />
              )}
              {playlist.songs?.length > 0 && (
                <Button
                  size="icon"
                  variant="outline"
                  className="absolute bottom-2 right-2 h-10 w-10 rounded-full border-white/25 bg-background/80 opacity-0 backdrop-blur-sm group-hover:opacity-100 transition-opacity"
                  onClick={() => setSongList(playlist.songs as any, 0)}
                  aria-label={`Play ${playlist.name}`}
                >
                  <Play className="h-5 w-5 fill-current" />
                </Button>
              )}
            </div>
            <Link
              to={ROUTES.PLAYLIST.PAGE(playlist.id)}
              className="hover:underline"
            >
              <p className="text-sm font-medium truncate">{playlist.name}</p>
            </Link>
            <p className="text-xs text-muted-foreground truncate">
              {playlist.curatorName || 'Apple Music'}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}
