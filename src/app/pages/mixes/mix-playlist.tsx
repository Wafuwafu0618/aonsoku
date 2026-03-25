import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useParams } from 'react-router-dom'
import { Actions } from '@/app/components/actions'
import ImageHeader from '@/app/components/album/image-header'
import { BadgesData } from '@/app/components/header-info'
import ListWrapper from '@/app/components/list-wrapper'
import { DataTable } from '@/app/components/ui/data-table'
import { Button } from '@/app/components/ui/button'
import ErrorPage from '@/app/pages/error-page'
import { songsColumns } from '@/app/tables/songs-columns'
import { usePlayerActions } from '@/store/player.store'
import { ColumnFilter } from '@/types/columnFilter'
import { ISong } from '@/types/responses/song'
import { convertSecondsToHumanRead } from '@/utils/convertSecondsToTime'

interface MixRouteState {
  mixId: string
  title: string
  description: string
  coverArt: string
  songs: ISong[]
}

const INSTRUMENTAL_PATTERNS = [
  /\binst(?:\.|rumental)?\b/i,
  /\binstrumental\b/i,
  /\boff[\s-]?vocal\b/i,
  /\bkaraoke\b/i,
  /インスト/i,
  /カラオケ/i,
  /オフ[ -]?ボーカル/i,
]

function hasInstrumentalMarker(title: string) {
  return INSTRUMENTAL_PATTERNS.some((pattern) => pattern.test(title))
}

function toRouteState(value: unknown): MixRouteState | null {
  if (!value || typeof value !== 'object') return null

  const state = value as Partial<MixRouteState>
  if (!state.mixId || !state.title || !Array.isArray(state.songs)) return null

  return {
    mixId: state.mixId,
    title: state.title,
    description: state.description ?? '',
    coverArt: state.coverArt ?? '',
    songs: state.songs,
  }
}

export default function MixPlaylist() {
  const { mixId } = useParams() as { mixId: string }
  const location = useLocation()
  const { t } = useTranslation()
  const { setSongList } = usePlayerActions()
  const [includeInstrumental, setIncludeInstrumental] = useState(false)
  const columns = songsColumns()
  const state = toRouteState(location.state)

  if (!state || state.mixId !== mixId) {
    return (
      <ErrorPage
        status={404}
        statusText="Mix playlist not found. Please recreate it from Home."
      />
    )
  }

  const songs = state.songs
  const songsWithoutInstrumental = useMemo(
    () => songs.filter((song) => !hasInstrumentalMarker(song.title)),
    [songs],
  )
  const instrumentalCount = songs.length - songsWithoutInstrumental.length
  const visibleSongs = includeInstrumental ? songs : songsWithoutInstrumental
  const hasSongs = visibleSongs.length > 0
  const duration = convertSecondsToHumanRead(
    visibleSongs.reduce((total, song) => total + (song.duration ?? 0), 0),
  )

  const badges: BadgesData = [
    { content: t('playlist.songCount', { count: visibleSongs.length }), type: 'text' },
    { content: t('playlist.duration', { duration }), type: 'text' },
  ]

  const columnsToShow: ColumnFilter[] = [
    'index',
    'title',
    'album',
    'duration',
    'playCount',
    'contentType',
    'select',
  ]

  return (
    <div className="w-full" key={state.mixId}>
      <ImageHeader
        type="Mix"
        title={state.title}
        subtitle={state.description}
        coverArtId={state.coverArt}
        coverArtType="album"
        coverArtSize="700"
        coverArtAlt={state.title}
        badges={badges}
        isPlaylist={true}
      />

      <ListWrapper>
        <Actions.Container>
          <Actions.Button
            buttonStyle="primary"
            tooltip={t('playlist.buttons.play', { name: state.title })}
            onClick={() => setSongList(visibleSongs, 0)}
            disabled={!hasSongs}
          >
            <Actions.PlayIcon />
          </Actions.Button>
          <Actions.Button
            tooltip={t('playlist.buttons.shuffle', { name: state.title })}
            onClick={() => setSongList(visibleSongs, 0, true)}
            disabled={!hasSongs}
          >
            <Actions.ShuffleIcon />
          </Actions.Button>
          <Button
            type="button"
            variant={includeInstrumental ? 'secondary' : 'outline'}
            size="sm"
            className="ml-2 h-9 rounded-full"
            onClick={() => setIncludeInstrumental((current) => !current)}
            disabled={instrumentalCount === 0}
          >
            {includeInstrumental ? 'インストを除外する' : `インストを含める (${instrumentalCount})`}
          </Button>
        </Actions.Container>

        <DataTable
          columns={columns}
          data={visibleSongs}
          handlePlaySong={(row) => setSongList(visibleSongs, row.index)}
          columnFilter={columnsToShow}
          noRowsMessage={
            includeInstrumental
              ? t('playlist.noSongList')
              : 'インスト除外中のため表示できる曲がありません。ボタンから「インストを含める」を有効にしてください。'
          }
          variant="modern"
        />
      </ListWrapper>
    </div>
  )
}
