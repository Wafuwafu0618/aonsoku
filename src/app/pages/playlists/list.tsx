import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { PlusIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { ShadowHeader } from '@/app/components/album/shadow-header'
import { SongListFallback } from '@/app/components/fallbacks/song-fallbacks'
import { HeaderTitle } from '@/app/components/header-title'
import ListWrapper from '@/app/components/list-wrapper'
import { EmptyPlaylistsPage } from '@/app/components/playlist/empty-page'
import { Button } from '@/app/components/ui/button'
import { DataTable } from '@/app/components/ui/data-table'
import { useGetAppleMusicLibraryPage } from '@/app/hooks/use-apple-music'
import { mapAppleMusicSongsToAppSongs } from '@/domain/mappers/apple-music'
import { playlistsColumns } from '@/app/tables/playlists-columns'
import { subsonic } from '@/service/subsonic'
import { useMediaLibraryMode } from '@/store/app.store'
import { usePlayerActions } from '@/store/player.store'
import { usePlaylists } from '@/store/playlists.store'
import { AppleMusicPlaylist } from '@/types/responses/apple-music'
import { queryKeys } from '@/utils/queryKeys'

export default function PlaylistsPage() {
  const { setPlaylistDialogState } = usePlaylists()
  const { setSongList } = usePlayerActions()
  const { t } = useTranslation()
  const { mode } = useMediaLibraryMode()

  const { data: playlists, isLoading } = useQuery({
    queryKey: [queryKeys.playlist.all],
    queryFn: subsonic.playlists.getAll,
    enabled: mode === 'navidrome',
  })

  const columns = playlistsColumns()

  async function handlePlayPlaylist(playlistId: string) {
    const playlist = await subsonic.playlists.getOne(playlistId)

    if (playlist && playlist.entry.length > 0) {
      setSongList(playlist.entry, 0)
    }
  }

  if (mode === 'applemusic') {
    return <AppleMusicPlaylistsList />
  }

  if (isLoading) return <SongListFallback />
  if (!playlists) return null

  const showTable = playlists.length > 0

  return (
    <div className={clsx('w-full', showTable ? 'h-full' : 'h-empty-content')}>
      <ShadowHeader>
        <div className="w-full flex items-center justify-between">
          <HeaderTitle
            title={t('sidebar.playlists')}
            count={playlists.length}
          />
        </div>

        <Button
          size="sm"
          variant="default"
          className="px-4"
          onClick={() => setPlaylistDialogState(true)}
        >
          <PlusIcon className="w-5 h-5 -ml-[3px]" />
          <span className="ml-2">{t('playlist.form.create.title')}</span>
        </Button>
      </ShadowHeader>

      {!showTable && <EmptyPlaylistsPage />}

      {showTable && (
        <ListWrapper>
          <DataTable
            columns={columns}
            data={playlists}
            showPagination={true}
            showSearch={true}
            searchColumn="name"
            handlePlaySong={(row) => handlePlayPlaylist(row.original.id)}
            allowRowSelection={false}
            dataType="playlist"
            noRowsMessage={t('options.playlist.notFound')}
          />
        </ListWrapper>
      )}
    </div>
  )
}

function AppleMusicPlaylistsList() {
  const { t } = useTranslation()
  const { setSongList } = usePlayerActions()
  const { data: libraryData, isLoading } = useGetAppleMusicLibraryPage({
    limit: 100,
    offset: 0,
  })

  const playlists = libraryData?.playlists ?? []
  const playlistsCount = playlists.length

  const columns = playlistsColumns()

  function handlePlayPlaylist(playlist: AppleMusicPlaylist) {
    if (playlist.songs && playlist.songs.length > 0) {
      const mappedSongs = mapAppleMusicSongsToAppSongs(playlist.songs)
      setSongList(mappedSongs, 0)
    }
  }

  // Map Apple Music playlists to app playlist format
  const displayPlaylists = playlists.map((playlist: AppleMusicPlaylist) => ({
    id: playlist.id,
    name: playlist.name,
    songCount: playlist.trackCount || 0,
    owner: playlist.curatorName || 'Apple Music',
    comment: '',
    public: true,
    createdAt: '',
    changedAt: '',
    coverArt: playlist.artworkUrl || '',
  }))

  if (isLoading) return <SongListFallback />

  const showTable = displayPlaylists.length > 0

  return (
    <div className={clsx('w-full', showTable ? 'h-full' : 'h-empty-content')}>
      <ShadowHeader>
        <div className="w-full flex items-center justify-between">
          <HeaderTitle title={t('sidebar.playlists')} count={playlistsCount} />
        </div>
      </ShadowHeader>

      {!showTable && <EmptyPlaylistsPage />}

      {showTable && (
        <ListWrapper>
          <DataTable
            columns={columns}
            data={displayPlaylists}
            showPagination={true}
            showSearch={true}
            searchColumn="name"
            handlePlaySong={(row) => handlePlayPlaylist(playlists[row.index])}
            allowRowSelection={false}
            dataType="playlist"
            noRowsMessage={t('options.playlist.notFound')}
          />
        </ListWrapper>
      )}
    </div>
  )
}
