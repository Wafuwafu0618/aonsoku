import { Link } from 'react-router-dom'
import { ArtistLink, ArtistsLinks } from '@/app/components/song/artist-link'
import { SourceBadge } from '@/app/components/source-badge'
import PlaySongButton from '@/app/components/table/play-button'
import { QueueActions } from '@/app/components/table/queue-actions'
import { TableSongTitle } from '@/app/components/table/song-title'
import { QueueItem } from '@/domain/entities/queue-item'
import { ROUTES } from '@/routes/routesList'
import { usePlayerStore } from '@/store/player.store'
import { getQueueItemDisplayInfo } from '@/store/queue-adapter'
import { ColumnDefType } from '@/types/react-table/columnDef'
import { ISong } from '@/types/responses/song'
import { convertSecondsToTime } from '@/utils/convertSecondsToTime'

/**
 * QueueItemまたはISongから表示用情報を抽出するヘルパー
 */
function extractDisplayInfo(item: QueueItem | ISong) {
  // QueueItemの場合
  if ('mediaType' in item) {
    return getQueueItemDisplayInfo(item)
  }
  // ISongの場合（radio/podcast用のフォールバック）
  return {
    id: item.id,
    title: item.title,
    artist: item.artist,
    album: item.album,
    duration: item.duration,
    coverArtId: item.coverArt,
    source: 'navidrome' as const,
    sourceId: item.id,
  }
}

/**
 * QueueItemまたはISongからアーティスト情報を抽出
 */
function extractArtistInfo(item: QueueItem | ISong) {
  if ('mediaType' in item) {
    return {
      artist: item.primaryArtist,
      artistId: item.track?.artistId,
      artists: item.track?.artists,
    }
  }
  return {
    artist: item.artist,
    artistId: item.artistId,
    artists: item.artists,
  }
}

/**
 * QueueItemまたはISongからアルバムIDを抽出
 */
function extractAlbumId(item: QueueItem | ISong): string | undefined {
  if ('mediaType' in item) {
    return item.track?.albumId
  }
  return item.albumId
}

export function queueColumns(): ColumnDefType<QueueItem | ISong>[] {
  return [
    {
      id: 'index',
      accessorKey: 'index',
      style: {
        width: 48,
        minWidth: 48,
      },
      header: '',
      cell: ({ row, table }) => {
        const trackNumber = row.index + 1
        const item = row.original

        return (
          <PlaySongButton
            trackNumber={trackNumber}
            trackId={extractDisplayInfo(item).id}
            handlePlayButton={() => table.options.meta?.handlePlaySong?.(row)}
          />
        )
      },
    },
    {
      id: 'title',
      accessorKey: 'title',
      style: {
        flex: 1,
        minWidth: 150,
      },
      header: '',
      cell: ({ row }) => {
        const item = row.original
        const info = extractDisplayInfo(item)

        return (
          <div className="flex items-center gap-2">
            <TableSongTitle
              song={item}
              customTitle={info.title}
              customCoverArtId={info.coverArtId}
            />
            {/* WP5: Sourceバッジ表示（songのみ） */}
            {'mediaType' in item && (
              <SourceBadge source={item.source} showLabel={false} />
            )}
          </div>
        )
      },
    },
    {
      id: 'artist',
      accessorKey: 'artist',
      style: {
        width: '30%',
        maxWidth: '30%',
      },
      header: '',
      cell: ({ row }) => {
        const item = row.original
        const { artist, artistId, artists } = extractArtistInfo(item)
        const { closeDrawer } = usePlayerStore.getState().actions

        if (artists && artists.length > 1) {
          return <ArtistsLinks artists={artists} onClickLink={closeDrawer} />
        }

        if (!artistId) return artist

        return (
          <ArtistLink artistId={artistId} onClick={closeDrawer}>
            {artist}
          </ArtistLink>
        )
      },
    },
    {
      id: 'album',
      accessorKey: 'album',
      style: {
        width: '24%',
        minWidth: '14%',
        maxWidth: '24%',
      },
      className: 'hidden lg:flex',
      enableSorting: true,
      sortingFn: 'customSortFn',
      header: '',
      cell: ({ row }) => {
        const item = row.original
        const info = extractDisplayInfo(item)
        const albumId = extractAlbumId(item)
        const { closeDrawer } = usePlayerStore.getState().actions

        if (!albumId) {
          return <span className="text-foreground/70">{info.album}</span>
        }

        return (
          <Link
            to={ROUTES.ALBUM.PAGE(albumId)}
            className="hover:underline truncate text-foreground/70 hover:text-foreground"
            onContextMenu={(e) => {
              e.stopPropagation()
              e.preventDefault()
            }}
            onClick={closeDrawer}
          >
            {info.album}
          </Link>
        )
      },
    },
    {
      id: 'duration',
      accessorKey: 'duration',
      style: {
        width: 80,
        maxWidth: 80,
        minWidth: 80,
      },
      header: '',
      cell: ({ row }) => {
        const item = row.original
        const info = extractDisplayInfo(item)
        const formattedDuration = convertSecondsToTime(info.duration ?? 0)

        return formattedDuration
      },
    },
    {
      id: 'remove',
      style: {
        width: 60,
        maxWidth: 60,
        minWidth: 60,
      },
      cell: ({ row }) => <QueueActions row={row} />,
    },
  ]
}
