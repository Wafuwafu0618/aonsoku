import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import { useRemoteCommands } from '../../hooks/useRemoteCommands'
import * as remoteApi from '../../lib/remoteApi'

const ALBUM_SONG_FETCH_LIMIT = 400

interface AlbumDetailPageProps {
  leaseId?: string
  album: remoteApi.NavidromeAlbum
  nowPlayingId?: string
  isPlaying?: boolean
  onBack: () => void
}

export function AlbumDetailPage({
  leaseId,
  album,
  nowPlayingId,
  isPlaying,
  onBack,
}: AlbumDetailPageProps) {
  const { playAlbum, playSong, playPause } = useRemoteCommands(leaseId)
  const [commandError, setCommandError] = useState<string | null>(null)
  const [pendingSongId, setPendingSongId] = useState<string | null>(null)

  const { data: songs = [], isLoading } = useQuery({
    queryKey: ['album-detail', leaseId, album.id],
    queryFn: ({ signal }) =>
      leaseId
        ? remoteApi.getSongs(
            leaseId,
            album.id,
            ALBUM_SONG_FETCH_LIMIT,
            0,
            signal,
          )
        : Promise.resolve([]),
    enabled: Boolean(leaseId && album.id),
    retry: false,
    staleTime: 60 * 1000,
  })

  const totalDurationSeconds = useMemo(
    () => songs.reduce((sum, song) => sum + Math.max(0, song.duration || 0), 0),
    [songs],
  )

  const isCurrentAlbumPlaying = useMemo(() => {
    if (!nowPlayingId || songs.length === 0) return false
    return songs.some((song) => song.id === nowPlayingId)
  }, [nowPlayingId, songs])

  async function handlePlayAlbum() {
    if (!leaseId) return
    setCommandError(null)
    try {
      await playAlbum(album.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      setCommandError(
        message ? `アルバム再生に失敗: ${message}` : 'アルバム再生の開始に失敗しました',
      )
    }
  }

  async function handlePlaySong(song: remoteApi.NavidromeSong) {
    if (!leaseId) return
    setCommandError(null)
    setPendingSongId(song.id)
    try {
      await playSong(album.id, song.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      setCommandError(
        message ? `曲の再生に失敗: ${message}` : '曲の再生に失敗しました',
      )
    } finally {
      setPendingSongId(null)
    }
  }

  async function handleTogglePlayPause() {
    if (!leaseId) return
    setCommandError(null)
    try {
      await playPause()
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      setCommandError(
        message
          ? `再生/一時停止に失敗: ${message}`
          : '再生/一時停止の操作に失敗しました',
      )
    }
  }

  return (
    <div className="album-detail-page p-4 pb-24">
      <button
        type="button"
        onClick={onBack}
        className="album-detail-back text-muted-foreground hover:text-foreground"
      >
        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2.2}
            d="M15 18l-6-6 6-6"
          />
        </svg>
      </button>

      <section className="album-detail-hero">
        <div className="album-detail-cover bg-muted">
          {album.coverArt ? (
            <img
              src={`/api/remote/cover?leaseId=${encodeURIComponent(leaseId ?? '')}&id=${encodeURIComponent(album.coverArt)}`}
              alt={album.name}
              className="album-detail-cover-img"
              loading="lazy"
            />
          ) : null}
        </div>

        <h1 className="album-detail-title media-title">{album.name}</h1>
        <p className="album-detail-artist media-title">{album.artist}</p>
        <p className="album-detail-meta media-subtitle">
          アルバム
          {album.year ? `・${album.year}年` : ''}
          {songs.length > 0 ? `・${songs.length}曲` : ''}
          {songs.length > 0 ? `・${formatLongDuration(totalDurationSeconds)}` : ''}
        </p>

        <div className="album-detail-actions">
          <button
            type="button"
            onClick={handlePlayAlbum}
            className="album-detail-play-btn"
          >
            <svg fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5.5v13l10-6.5z" />
            </svg>
            再生
          </button>
          <button
            type="button"
            onClick={handleTogglePlayPause}
            className="album-detail-secondary-btn"
          >
            {isPlaying && isCurrentAlbumPlaying ? '一時停止' : '再生/一時停止'}
          </button>
        </div>

        {commandError && (
          <p className="album-detail-error text-xs text-destructive">{commandError}</p>
        )}
      </section>

      <section className="album-detail-tracklist">
        {isLoading ? (
          <div className="py-8 flex justify-center">
            <div className="animate-spin rounded-full h-7 w-7 border-b-2 border-primary" />
          </div>
        ) : songs.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6">
            このアルバムの曲を取得できませんでした
          </p>
        ) : (
          songs.map((song, index) => {
            const isActive = nowPlayingId === song.id
            const isPending = pendingSongId === song.id
            return (
              <button
                key={song.id}
                type="button"
                className={cn(
                  'album-detail-track-row',
                  isActive && 'album-detail-track-row-active',
                )}
                onClick={() => handlePlaySong(song)}
                disabled={isPending}
              >
                <span className="album-detail-track-index">{song.track || index + 1}</span>
                <div className="album-detail-track-meta">
                  <p className="album-detail-track-title media-title truncate">
                    {song.title}
                  </p>
                  <p className="album-detail-track-artist media-subtitle truncate">
                    {song.artist}
                  </p>
                  <div className="album-detail-track-divider" />
                </div>
                <span className="album-detail-track-duration media-subtitle">
                  {isPending ? '...' : formatDuration(song.duration)}
                </span>
              </button>
            )
          })
        )}
      </section>
    </div>
  )
}

function formatDuration(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds || 0))
  const mins = Math.floor(safeSeconds / 60)
  const secs = safeSeconds % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

function formatLongDuration(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds || 0))
  const hours = Math.floor(safeSeconds / 3600)
  const minutes = Math.floor((safeSeconds % 3600) / 60)
  if (hours > 0) return `${hours}時間${minutes}分`
  return `${minutes}分`
}
