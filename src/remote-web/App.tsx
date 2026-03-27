import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  CSSProperties,
  ChangeEvent,
  KeyboardEvent,
  MouseEvent,
  PointerEvent,
  TouchEvent,
} from 'react'
import { cn } from '@/lib/utils'
import remoteBackgroundImage from './bg/0.png'
import { useRemoteAudioStream } from './hooks/useRemoteAudioStream'
import { useRemoteCommands } from './hooks/useRemoteCommands'
import { useRemoteSession } from './hooks/useRemoteSession'
import { useRemoteState } from './hooks/useRemoteState'
import type {
  NavidromeAlbum,
  RemotePlaybackDevice,
  RemotePlaybackTarget,
} from './lib/remoteApi'
import { AlbumDetailPage } from './pages/album/AlbumDetailPage'
import { HomePage } from './pages/home/HomePage'
import { LibraryPage } from './pages/library/LibraryPage'
import {
  RemoteWavePreset,
  RemoteWavePresetId,
  SettingsPage,
} from './pages/settings/SettingsPage'
import './styles/remote.css'

const REMOTE_WAVE_PRESET_STORAGE_KEY = 'minato.remote.wavePreset'
const PAUSED_POSITION_DRIFT_EPSILON_SECONDS = 1.2
const FALLBACK_PLAYBACK_DEVICES: RemotePlaybackDevice[] = [
  {
    id: 'desktop',
    name: 'このPC',
    description: 'ローカル再生（HQ SRC）',
    selected: true,
  },
  {
    id: 'mobile',
    name: 'このスマホ',
    description: 'リモート配信（HQ SRC WS）',
    selected: false,
  },
]

const REMOTE_WAVE_PRESETS: RemoteWavePreset[] = [
  {
    id: 'amethyst',
    name: 'Amethyst',
    description: 'Minato Wave 標準の紫系',
    colors: ['#be8dff', '#d67dff', '#8da4ff'],
  },
  {
    id: 'azure',
    name: 'Azure',
    description: '青寄りでクールなグロー',
    colors: ['#68b4ff', '#7fd3ff', '#7d95ff'],
  },
  {
    id: 'emerald',
    name: 'Emerald',
    description: '緑寄りで落ち着いた透明感',
    colors: ['#67e3c2', '#7fdeb1', '#82c8ff'],
  },
  {
    id: 'sunset',
    name: 'Sunset',
    description: '暖色寄りでドラマチック',
    colors: ['#ff8c9f', '#ffb37b', '#a88dff'],
  },
  {
    id: 'mono',
    name: 'Mono Mist',
    description: 'ニュートラルで暗めのガラス感',
    colors: ['#b9c0cc', '#9ea8ba', '#7a8494'],
  },
  {
    id: 'mock',
    name: 'Mock Noir',
    description: 'Figmaモック準拠の黒基調',
    colors: ['#090b10', '#1f232b', '#1fe06e'],
  },
]

type RemoteWaveCssVars = CSSProperties & {
  '--rw-bg-image'?: string
  '--rw-base'?: string
  '--rw-grad-a'?: string
  '--rw-grad-b'?: string
  '--rw-grad-c'?: string
  '--rw-glow-1'?: string
  '--rw-glow-2'?: string
  '--rw-glow-3'?: string
  '--rw-overlay-top'?: string
  '--rw-overlay-bottom'?: string
  '--foreground'?: string
  '--muted-foreground'?: string
  '--rw-panel-bg'?: string
  '--rw-chrome-bg'?: string
  '--rw-panel-border'?: string
  '--rw-panel-blur'?: string
  '--rw-panel-shadow'?: string
  '--rw-bg-blur'?: string
  '--rw-bg-filter'?: string
  '--rw-list-bg'?: string
  '--rw-list-border'?: string
  '--rw-list-blur'?: string
  '--rw-card-bg'?: string
  '--rw-card-border'?: string
  '--rw-card-blur'?: string
}

type NowPlayingCssVars = CSSProperties & {
  '--np-cover-image'?: string
}

function formatTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds || 0))
  const mins = Math.floor(safe / 60)
  const secs = safe % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

export default function App() {
  const {
    session,
    isClaiming,
    error: sessionError,
    claim,
    release,
  } = useRemoteSession()
  const { playPause, prev, next, seek, setPlaybackTarget } = useRemoteCommands(
    session?.leaseId,
  )
  const { state: remoteState, connectionStatus } = useRemoteState(session?.leaseId)
  const playbackTarget: RemotePlaybackTarget =
    remoteState?.playbackTarget ?? 'desktop'
  const playbackDevices = remoteState?.playbackDevices ?? FALLBACK_PLAYBACK_DEVICES
  const canStream = remoteState?.canStream === true

  useRemoteAudioStream({
    leaseId: session?.leaseId,
    playbackTarget,
    canStream,
  })

  const [activeTab, setActiveTab] = useState<
    'home' | 'library' | 'queue' | 'player' | 'settings'
  >('home')
  const [selectedAlbum, setSelectedAlbum] = useState<NavidromeAlbum | null>(null)
  const [wavePreset, setWavePreset] = useState<RemoteWavePresetId>('amethyst')
  const [isSeeking, setIsSeeking] = useState(false)
  const [seekPreviewSeconds, setSeekPreviewSeconds] = useState(0)
  const [displayCurrentSeconds, setDisplayCurrentSeconds] = useState(0)
  const [isNowPlayingExpanded, setIsNowPlayingExpanded] = useState(false)
  const [isDevicePickerOpen, setIsDevicePickerOpen] = useState(false)
  const [isRepeatEnabled, setIsRepeatEnabled] = useState(false)
  const [isLoopEnabled, setIsLoopEnabled] = useState(false)
  const seekCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pausedTrackIdRef = useRef<string | null>(null)
  const pausedPositionRef = useRef<number>(0)

  useEffect(() => {
    const savedPreset = localStorage.getItem(REMOTE_WAVE_PRESET_STORAGE_KEY)
    const found = REMOTE_WAVE_PRESETS.find((preset) => preset.id === savedPreset)
    if (found) {
      setWavePreset(found.id)
    }
  }, [])

  const selectedPreset = useMemo(
    () =>
      REMOTE_WAVE_PRESETS.find((preset) => preset.id === wavePreset) ??
      REMOTE_WAVE_PRESETS[0],
    [wavePreset],
  )

  const showNowPlayingBar = Boolean(
    remoteState?.mediaType === 'song' &&
      (remoteState?.isPlaying ||
        remoteState?.nowPlaying?.title ||
        remoteState?.nowPlaying?.artist ||
        remoteState?.nowPlaying?.album),
  )

  const nowPlayingDurationSeconds = useMemo(() => {
    const duration = remoteState?.durationSeconds ?? 0
    if (!Number.isFinite(duration) || duration <= 0) return 0
    return duration
  }, [remoteState?.durationSeconds])

  const nowPlayingCurrentSeconds = useMemo(() => {
    if (isSeeking) return seekPreviewSeconds
    return displayCurrentSeconds
  }, [displayCurrentSeconds, isSeeking, seekPreviewSeconds])

  const nowPlayingProgressPercent = useMemo(() => {
    const duration = nowPlayingDurationSeconds
    const current = nowPlayingCurrentSeconds
    if (!Number.isFinite(duration) || duration <= 0) return 0
    if (!Number.isFinite(current) || current <= 0) return 0
    return Math.max(0, Math.min(100, (current / duration) * 100))
  }, [nowPlayingCurrentSeconds, nowPlayingDurationSeconds])

  const nowPlayingSeekMax = Math.max(1, Math.floor(nowPlayingDurationSeconds))
  const nowPlayingSeekValue = Math.max(
    0,
    Math.min(nowPlayingSeekMax, Math.floor(nowPlayingCurrentSeconds)),
  )

  const nowPlayingSeekTrackStyle = useMemo<CSSProperties>(
    () => ({
      background: `linear-gradient(90deg, hsl(0 0% 98% / 0.95) 0%, hsl(0 0% 98% / 0.95) ${nowPlayingProgressPercent}%, hsl(0 0% 100% / 0.26) ${nowPlayingProgressPercent}%, hsl(0 0% 100% / 0.26) 100%)`,
    }),
    [nowPlayingProgressPercent],
  )

  const nowPlayingCoverUrl = useMemo(() => {
    const coverArtId = remoteState?.nowPlaying?.coverArtId
    if (!coverArtId || !session?.leaseId) return null
    return `/api/remote/cover?leaseId=${encodeURIComponent(session.leaseId)}&id=${encodeURIComponent(coverArtId)}`
  }, [remoteState?.nowPlaying?.coverArtId, session?.leaseId])

  const nowPlayingBarStyle = useMemo<NowPlayingCssVars | undefined>(() => {
    if (!nowPlayingCoverUrl) return undefined
    return {
      '--np-cover-image': `url("${nowPlayingCoverUrl}")`,
    }
  }, [nowPlayingCoverUrl])

  const nowPlayingSignalStatus = useMemo(() => {
    if (typeof remoteState?.signalPath === 'string' && remoteState.signalPath.trim()) {
      return remoteState.signalPath.trim()
    }

    const src = (remoteState?.src ?? '').toLowerCase()
    let codec = 'PCM'
    if (src.includes('.flac') || src.includes('format=flac')) codec = 'FLAC'
    else if (
      src.includes('.m4a') ||
      src.includes('.alac') ||
      src.includes('format=alac')
    ) {
      codec = 'ALAC'
    } else if (src.includes('.aac') || src.includes('format=aac')) codec = 'AAC'
    else if (src.includes('.mp3') || src.includes('format=mp3')) codec = 'MP3'

    if (playbackTarget === 'mobile') {
      return `${codec}, HQ SRC→Mobile WS PCM`
    }
    return `${codec}, HQ SRC→Desktop Output`
  }, [playbackTarget, remoteState?.signalPath, remoteState?.src])

  useEffect(() => {
    if (isSeeking) return

    const trackId = remoteState?.nowPlaying?.id ?? null
    const rawCurrent = remoteState?.currentTimeSeconds ?? 0
    const current =
      Number.isFinite(rawCurrent) && rawCurrent >= 0 ? rawCurrent : 0

    if (!trackId) {
      pausedTrackIdRef.current = null
      pausedPositionRef.current = current
      setDisplayCurrentSeconds(current)
      return
    }

    if (remoteState?.isPlaying) {
      pausedTrackIdRef.current = null
      pausedPositionRef.current = current
      setDisplayCurrentSeconds(current)
      return
    }

    if (pausedTrackIdRef.current !== trackId) {
      pausedTrackIdRef.current = trackId
      pausedPositionRef.current = current
      setDisplayCurrentSeconds(current)
      return
    }

    const locked = pausedPositionRef.current
    if (
      Math.abs(current - locked) >
      PAUSED_POSITION_DRIFT_EPSILON_SECONDS
    ) {
      // 停止中の明確なジャンプは seek 操作として反映
      pausedPositionRef.current = current
      setDisplayCurrentSeconds(current)
      return
    }

    setDisplayCurrentSeconds(locked)
  }, [
    isSeeking,
    remoteState?.currentTimeSeconds,
    remoteState?.isPlaying,
    remoteState?.nowPlaying?.id,
  ])

  useEffect(() => {
    if (isSeeking) return
    setSeekPreviewSeconds(displayCurrentSeconds)
  }, [displayCurrentSeconds, isSeeking])

  useEffect(() => {
    if (showNowPlayingBar) return
    setIsNowPlayingExpanded(false)
  }, [showNowPlayingBar])

  useEffect(() => {
    if (session) return
    setIsDevicePickerOpen(false)
  }, [session])

  useEffect(() => {
    // 曲切り替え時に seek 操作状態を必ず解放して、前曲の値が残るのを防ぐ
    setIsSeeking(false)
    if (seekCommitTimerRef.current) {
      clearTimeout(seekCommitTimerRef.current)
      seekCommitTimerRef.current = null
    }
    const current = remoteState?.currentTimeSeconds ?? 0
    if (Number.isFinite(current) && current >= 0) {
      setDisplayCurrentSeconds(current)
      setSeekPreviewSeconds(current)
      pausedTrackIdRef.current = remoteState?.nowPlaying?.id ?? null
      pausedPositionRef.current = current
    } else {
      setDisplayCurrentSeconds(0)
      setSeekPreviewSeconds(0)
      pausedTrackIdRef.current = remoteState?.nowPlaying?.id ?? null
      pausedPositionRef.current = 0
    }
  }, [remoteState?.nowPlaying?.id])

  useEffect(() => {
    return () => {
      if (seekCommitTimerRef.current) {
        clearTimeout(seekCommitTimerRef.current)
        seekCommitTimerRef.current = null
      }
    }
  }, [])

  const waveStyle = useMemo<RemoteWaveCssVars>(() => {
    const [c1, c2, c3] = selectedPreset.colors
    const isMono = selectedPreset.id === 'mono'
    const isMock = selectedPreset.id === 'mock'

    return {
      '--rw-bg-image': isMock ? 'none' : `url("${remoteBackgroundImage}")`,
      '--rw-base': isMock
        ? 'hsl(224 24% 6%)'
        : isMono
          ? 'hsl(224 16% 38%)'
          : 'hsl(276 20% 45%)',
      '--rw-grad-a': isMock ? 'transparent' : isMono ? '#8f98a855' : '#9c7be655',
      '--rw-grad-b': isMock ? 'transparent' : isMono ? '#a3aabc40' : '#d88bb640',
      '--rw-grad-c': isMock ? 'transparent' : isMono ? '#8690a533' : '#82b5dd33',
      '--rw-glow-1': isMock ? 'transparent' : `${c1}6b`,
      '--rw-glow-2': isMock ? 'transparent' : `${c2}5f`,
      '--rw-glow-3': isMock ? 'transparent' : `${c3}4f`,
      '--rw-overlay-top': isMock
        ? 'hsl(224 28% 4% / 0.92)'
        : isMono
          ? 'hsl(221 22% 8% / 0.2)'
          : 'hsl(252 32% 10% / 0.16)',
      '--rw-overlay-bottom': isMock
        ? 'hsl(224 28% 4% / 0.92)'
        : isMono
          ? 'hsl(221 22% 8% / 0.3)'
          : 'hsl(252 32% 10% / 0.24)',
      '--foreground': isMock ? '0 0% 95%' : isMono ? '0 0% 97%' : '275 52% 94%',
      '--muted-foreground': isMock
        ? '225 10% 74%'
        : isMono
          ? '220 18% 86%'
          : '270 32% 78%',
      '--rw-panel-bg': isMock
        ? 'hsl(220 14% 12% / 0.72)'
        : isMono
          ? 'hsl(220 20% 92% / 0.14)'
          : 'hsl(270 100% 98% / 0.14)',
      '--rw-chrome-bg': isMock
        ? 'hsl(220 14% 12% / 0.86)'
        : isMono
          ? 'hsl(220 20% 92% / 0.18)'
          : 'hsl(270 100% 98% / 0.2)',
      '--rw-panel-border': isMock
        ? 'hsl(220 10% 30% / 0.42)'
        : isMono
          ? 'hsl(220 28% 78% / 0.36)'
          : 'hsl(265 32% 72% / 0.4)',
      '--rw-panel-blur': 'blur(46px) saturate(180%) brightness(1.1)',
      '--rw-panel-shadow':
        isMock
          ? '0 10px 30px hsl(224 38% 2% / 0.48), inset 0 1px 0 hsl(0 0% 100% / 0.06)'
          : '0 16px 42px hsl(252 35% 8% / 0.36), inset 0 1px 0 hsl(0 0% 100% / 0.14)',
      '--rw-bg-blur': isMock
        ? 'blur(36px) saturate(135%) brightness(0.82)'
        : 'blur(62px) saturate(190%) brightness(1.08)',
      '--rw-bg-filter': isMock
        ? 'blur(4px) saturate(0.96) contrast(1.06) brightness(0.55)'
        : 'blur(18px) saturate(1.12) contrast(1.04) brightness(0.88)',
      '--rw-list-bg': isMock
        ? 'hsl(220 14% 12% / 0.68)'
        : isMono
          ? 'hsl(220 20% 92% / 0.13)'
          : 'hsl(270 100% 98% / 0.12)',
      '--rw-list-border': isMock
        ? 'hsl(220 10% 30% / 0.34)'
        : isMono
          ? 'hsl(220 28% 78% / 0.32)'
          : 'hsl(265 32% 72% / 0.34)',
      '--rw-list-blur': 'blur(26px) saturate(165%) brightness(1.08)',
      '--rw-card-bg': isMock
        ? 'hsl(220 14% 12% / 0.74)'
        : isMono
          ? 'hsl(220 20% 92% / 0.14)'
          : 'hsl(270 100% 98% / 0.14)',
      '--rw-card-border': isMock
        ? 'hsl(220 10% 30% / 0.38)'
        : isMono
          ? 'hsl(220 28% 78% / 0.36)'
          : 'hsl(265 32% 72% / 0.4)',
      '--rw-card-blur': 'blur(30px) saturate(170%) brightness(1.08)',
    }
  }, [selectedPreset])

  function handleSelectWavePreset(presetId: RemoteWavePresetId) {
    setWavePreset(presetId)
    localStorage.setItem(REMOTE_WAVE_PRESET_STORAGE_KEY, presetId)
  }

  function handleAlbumSelect(album: NavidromeAlbum) {
    setSelectedAlbum(album)
  }

  function handleCloseAlbumDetail() {
    setSelectedAlbum(null)
  }

  function handleTabChange(
    tab: 'home' | 'library' | 'queue' | 'player' | 'settings',
  ) {
    setActiveTab(tab)
    setSelectedAlbum(null)
  }

  function handleMiniPlayPause() {
    void playPause().catch(() => {
      // noop
    })
  }

  function handlePrev() {
    void prev().catch(() => {
      // noop
    })
  }

  function handleNext() {
    void next().catch(() => {
      // noop
    })
  }

  function handleOpenNowPlaying() {
    setIsNowPlayingExpanded(true)
  }

  function handleCloseNowPlaying() {
    setIsNowPlayingExpanded(false)
  }

  function handleOpenDevicePicker() {
    setIsDevicePickerOpen(true)
  }

  function handleCloseDevicePicker() {
    setIsDevicePickerOpen(false)
  }

  function handleSelectPlaybackTarget(target: RemotePlaybackTarget) {
    void setPlaybackTarget(target)
      .then(() => {
        setIsDevicePickerOpen(false)
      })
      .catch(() => {
        // noop
      })
  }

  function handleSeekInput(event: ChangeEvent<HTMLInputElement>) {
    const next = Number.parseFloat(event.target.value)
    if (!Number.isFinite(next)) return
    setIsSeeking(true)
    setSeekPreviewSeconds(next)

    // pointerup が抜ける環境対策: 入力中にも短い遅延で確定
    if (seekCommitTimerRef.current) {
      clearTimeout(seekCommitTimerRef.current)
    }
    seekCommitTimerRef.current = setTimeout(() => {
      commitSeek(next)
    }, 140)
  }

  function commitSeek(nextRaw: number) {
    if (seekCommitTimerRef.current) {
      clearTimeout(seekCommitTimerRef.current)
      seekCommitTimerRef.current = null
    }
    setIsSeeking(false)
    if (nowPlayingDurationSeconds <= 0) return
    const next = Math.max(0, Math.min(nowPlayingDurationSeconds, nextRaw))
    setDisplayCurrentSeconds(next)
    setSeekPreviewSeconds(next)
    if (remoteState?.isPlaying !== true) {
      pausedTrackIdRef.current = remoteState?.nowPlaying?.id ?? null
      pausedPositionRef.current = next
    }
    void seek(next).catch(() => {
      // noop
    })
  }

  function handleSeekPointerDown() {
    if (nowPlayingDurationSeconds <= 0) return
    setIsSeeking(true)
  }

  function handleSeekPointerUp(event: PointerEvent<HTMLInputElement>) {
    const next = Number.parseFloat(event.currentTarget.value)
    if (!Number.isFinite(next)) {
      commitSeek(seekPreviewSeconds)
      return
    }
    commitSeek(next)
  }

  function handleSeekMouseUp(event: MouseEvent<HTMLInputElement>) {
    const next = Number.parseFloat(event.currentTarget.value)
    if (!Number.isFinite(next)) {
      commitSeek(seekPreviewSeconds)
      return
    }
    commitSeek(next)
  }

  function handleSeekTouchEnd(event: TouchEvent<HTMLInputElement>) {
    const next = Number.parseFloat(event.currentTarget.value)
    if (!Number.isFinite(next)) {
      commitSeek(seekPreviewSeconds)
      return
    }
    commitSeek(next)
  }

  function handleSeekBlur() {
    if (!isSeeking) return
    commitSeek(seekPreviewSeconds)
  }

  function handleSeekKeyUp(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter' && event.key !== ' ') return
    commitSeek(seekPreviewSeconds)
  }

  // セッション未所持時は接続画面を表示
  if (!session && !isClaiming) {
    return (
      <div
        className="remote-wave min-h-screen bg-background flex items-center justify-center p-4"
        style={waveStyle}
      >
        <div className="w-full max-w-md space-y-6">
          <div className="text-center space-y-2">
            <h1 className="text-3xl font-bold tracking-tight">Minato Remote</h1>
            <p className="text-muted-foreground">
              デスクトップアプリから接続して音楽を操作
            </p>
          </div>

          {sessionError && (
            <div className="p-4 rounded-lg bg-destructive/10 text-destructive text-sm">
              {sessionError}
            </div>
          )}

          <button
            onClick={claim}
            className={cn(
              'w-full py-4 px-6 rounded-lg font-medium transition-colors',
              'bg-primary text-primary-foreground hover:bg-primary/90',
              'disabled:opacity-50 disabled:cursor-not-allowed',
            )}
            disabled={isClaiming}
          >
            {isClaiming ? '接続中...' : '接続する'}
          </button>
        </div>
      </div>
    )
  }

  // セッション取得中
  if (isClaiming) {
    return (
      <div
        className="remote-wave min-h-screen bg-background flex items-center justify-center"
        style={waveStyle}
      >
        <div className="text-center space-y-4">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto" />
          <p className="text-muted-foreground">セッションを取得中...</p>
        </div>
      </div>
    )
  }

  // メインアプリ
  return (
    <div
      className="remote-wave min-h-screen bg-background flex flex-col"
      style={waveStyle}
    >
      {/* ヘッダー */}
      <header className="remote-wave-header sticky top-0 z-50 w-full border-b">
        <div className="flex h-14 items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'remote-connection-pill',
                connectionStatus === 'connected'
                  ? 'remote-connection-pill-connected'
                  : 'remote-connection-pill-reconnecting',
              )}
            >
              {connectionStatus === 'connected' ? '接続中' : '再接続中'}
            </span>
            <span className="remote-playback-target-chip">
              {playbackTarget === 'mobile' ? 'このスマホ' : 'このPC'}
            </span>
          </div>
          <button
            onClick={release}
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            切断
          </button>
        </div>
      </header>

      {/* メインコンテンツ */}
      <main className={cn('flex-1 overflow-auto', showNowPlayingBar && 'pb-20')}>
        {selectedAlbum ? (
          <AlbumDetailPage
            leaseId={session?.leaseId}
            album={selectedAlbum}
            nowPlayingId={remoteState?.nowPlaying?.id}
            isPlaying={remoteState?.isPlaying}
            onBack={handleCloseAlbumDetail}
          />
        ) : (
          <>
            {activeTab === 'home' && (
              <HomePage
                leaseId={session?.leaseId}
                onAlbumSelect={handleAlbumSelect}
              />
            )}
            {activeTab === 'library' && (
              <LibraryPage
                leaseId={session?.leaseId}
                onAlbumSelect={handleAlbumSelect}
              />
            )}
            {activeTab === 'queue' && <div className="p-4">Queue（Phase 2）</div>}
            {activeTab === 'player' && <div className="p-4">Player（Phase 3）</div>}
            {activeTab === 'settings' && (
              <SettingsPage
                presets={REMOTE_WAVE_PRESETS}
                selectedPreset={wavePreset}
                onSelectPreset={handleSelectWavePreset}
              />
            )}
          </>
        )}
      </main>

      {showNowPlayingBar && (
        <div className="remote-now-playing-shell">
          <div
            className="remote-now-playing-card"
            style={nowPlayingBarStyle}
            onClick={handleOpenNowPlaying}
          >
            <div className="remote-now-playing-main">
              <div className="remote-now-playing-cover bg-muted">
                {nowPlayingCoverUrl ? (
                  <img
                    src={nowPlayingCoverUrl}
                    alt={remoteState?.nowPlaying?.title ?? 'cover'}
                    className="remote-now-playing-cover-img"
                    loading="lazy"
                  />
                ) : (
                  <span className="remote-now-playing-cover-fallback">♪</span>
                )}
              </div>
              <div className="remote-now-playing-meta">
                <p className="remote-now-playing-title truncate">
                  {remoteState?.nowPlaying?.title}
                </p>
                <p className="remote-now-playing-artist truncate">
                  {remoteState?.nowPlaying?.artist || remoteState?.nowPlaying?.album || ''}
                </p>
              </div>
              <div className="remote-now-playing-actions">
                <button
                  type="button"
                  className={cn(
                    'remote-now-playing-btn remote-now-playing-btn-secondary',
                    playbackTarget === 'mobile' &&
                      'remote-now-playing-btn-secondary-active',
                  )}
                  aria-label="playback target"
                  onClick={(event) => {
                    event.stopPropagation()
                    handleOpenDevicePicker()
                  }}
                >
                  <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 6h16v10H4zM9 20h6"
                    />
                  </svg>
                </button>
                <button
                  type="button"
                  className="remote-now-playing-btn remote-now-playing-btn-primary"
                  onClick={(event) => {
                    event.stopPropagation()
                    handleMiniPlayPause()
                  }}
                  aria-label={remoteState?.isPlaying ? 'pause' : 'play'}
                >
                  {remoteState?.isPlaying ? (
                    <svg fill="currentColor" viewBox="0 0 24 24">
                      <path d="M7 5h4v14H7zm6 0h4v14h-4z" />
                    </svg>
                  ) : (
                    <svg fill="currentColor" viewBox="0 0 24 24">
                      <path d="M8 5.5v13l10-6.5z" />
                    </svg>
                  )}
                </button>
              </div>
            </div>
            <div className="remote-now-playing-progress-shell">
              <input
                type="range"
                min={0}
                max={nowPlayingSeekMax}
                step={1}
                value={nowPlayingSeekValue}
                className="remote-now-playing-seek"
                style={nowPlayingSeekTrackStyle}
                disabled={nowPlayingDurationSeconds <= 0}
                onClick={(event) => event.stopPropagation()}
                onPointerDown={handleSeekPointerDown}
                onPointerUp={handleSeekPointerUp}
                onMouseUp={handleSeekMouseUp}
                onTouchEnd={handleSeekTouchEnd}
                onChange={handleSeekInput}
                onBlur={handleSeekBlur}
                onKeyUp={handleSeekKeyUp}
              />
            </div>
          </div>
        </div>
      )}

      {showNowPlayingBar && isNowPlayingExpanded && (
        <div
          className="remote-now-playing-overlay"
          style={nowPlayingBarStyle}
          onClick={handleCloseNowPlaying}
        >
          <div
            className="remote-now-playing-overlay-card"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="remote-now-playing-overlay-header">
              <button
                type="button"
                className="remote-now-playing-overlay-close"
                onClick={handleCloseNowPlaying}
                aria-label="close"
              >
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 6l12 12M18 6L6 18"
                  />
                </svg>
              </button>
              <p className="remote-now-playing-overlay-mini-title media-title truncate">
                {remoteState?.nowPlaying?.album || remoteState?.nowPlaying?.title || 'Now Playing'}
              </p>
              <button
                type="button"
                className="remote-now-playing-overlay-more"
                aria-label="more"
              >
                <svg fill="currentColor" viewBox="0 0 24 24">
                  <circle cx="6" cy="12" r="1.8" />
                  <circle cx="12" cy="12" r="1.8" />
                  <circle cx="18" cy="12" r="1.8" />
                </svg>
              </button>
            </header>

            <div className="remote-now-playing-overlay-cover-wrap">
              <div className="remote-now-playing-overlay-cover bg-muted">
                {nowPlayingCoverUrl ? (
                  <img
                    src={nowPlayingCoverUrl}
                    alt={remoteState?.nowPlaying?.title ?? 'cover'}
                    className="remote-now-playing-overlay-cover-img"
                    loading="lazy"
                  />
                ) : (
                  <span className="remote-now-playing-cover-fallback">♪</span>
                )}
              </div>
            </div>

            <div className="remote-now-playing-overlay-meta">
              <p className="remote-now-playing-overlay-title media-title truncate">
                {remoteState?.nowPlaying?.title || 'No Track'}
              </p>
              <p className="remote-now-playing-overlay-artist media-subtitle truncate">
                {remoteState?.nowPlaying?.artist || remoteState?.nowPlaying?.album || ''}
              </p>
            </div>

            <div className="remote-now-playing-overlay-seek-wrap">
              <input
                type="range"
                min={0}
                max={nowPlayingSeekMax}
                step={1}
                value={nowPlayingSeekValue}
                className="remote-now-playing-seek"
                style={nowPlayingSeekTrackStyle}
                disabled={nowPlayingDurationSeconds <= 0}
                onPointerDown={handleSeekPointerDown}
                onPointerUp={handleSeekPointerUp}
                onMouseUp={handleSeekMouseUp}
                onTouchEnd={handleSeekTouchEnd}
                onChange={handleSeekInput}
                onBlur={handleSeekBlur}
                onKeyUp={handleSeekKeyUp}
              />
              <div className="remote-now-playing-overlay-seek-time">
                <span>{formatTime(nowPlayingCurrentSeconds)}</span>
                <span>{formatTime(nowPlayingDurationSeconds)}</span>
              </div>
            </div>

            <div className="remote-now-playing-overlay-controls">
              <div className="remote-now-playing-overlay-controls-side remote-now-playing-overlay-controls-side-left">
                <button
                  type="button"
                  className={cn(
                    'remote-now-playing-overlay-mode-btn',
                    isRepeatEnabled && 'remote-now-playing-overlay-mode-btn-active',
                  )}
                  onClick={() => setIsRepeatEnabled((value) => !value)}
                  aria-label="toggle repeat"
                >
                  <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M17 3l4 4-4 4M3 7h18M7 21l-4-4 4-4M21 17H3"
                    />
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 8.6v6.8M10.8 9.9h1.2"
                    />
                  </svg>
                </button>
                <button
                  type="button"
                  className="remote-now-playing-overlay-icon-btn"
                  onClick={handlePrev}
                  aria-label="prev"
                >
                  <svg fill="currentColor" viewBox="0 0 24 24">
                    <path d="M7 6h2v12H7zM10 12l8-6v12z" />
                  </svg>
                </button>
              </div>

              <button
                type="button"
                className="remote-now-playing-overlay-play-btn"
                onClick={handleMiniPlayPause}
                aria-label={remoteState?.isPlaying ? 'pause' : 'play'}
              >
                {remoteState?.isPlaying ? (
                  <svg fill="currentColor" viewBox="0 0 24 24">
                    <path d="M7 5h4v14H7zm6 0h4v14h-4z" />
                  </svg>
                ) : (
                  <svg fill="currentColor" viewBox="0 0 24 24">
                    <path d="M8 5.5v13l10-6.5z" />
                  </svg>
                )}
              </button>

              <div className="remote-now-playing-overlay-controls-side remote-now-playing-overlay-controls-side-right">
                <button
                  type="button"
                  className="remote-now-playing-overlay-icon-btn"
                  onClick={handleNext}
                  aria-label="next"
                >
                  <svg fill="currentColor" viewBox="0 0 24 24">
                    <path d="M15 6h2v12h-2zM6 12l8-6v12z" />
                  </svg>
                </button>
                <button
                  type="button"
                  className={cn(
                    'remote-now-playing-overlay-mode-btn',
                    isLoopEnabled && 'remote-now-playing-overlay-mode-btn-active',
                  )}
                  onClick={() => setIsLoopEnabled((value) => !value)}
                  aria-label="toggle loop"
                >
                  <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M17 3l4 4-4 4M3 7h18M7 21l-4-4 4-4M21 17H3"
                    />
                  </svg>
                </button>
              </div>
            </div>

            <div className="remote-now-playing-overlay-signal">
              <button
                type="button"
                className={cn(
                  'remote-now-playing-overlay-mode-btn',
                  playbackTarget === 'mobile' &&
                    'remote-now-playing-overlay-mode-btn-active',
                )}
                aria-label="playback target"
                onClick={handleOpenDevicePicker}
              >
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 6h16v10H4zM9 20h6"
                  />
                </svg>
              </button>
              <p className="remote-now-playing-overlay-status-line">
                {nowPlayingSignalStatus}
              </p>
            </div>
          </div>
        </div>
      )}

      {isDevicePickerOpen && (
        <div
          className="remote-device-picker-backdrop"
          onClick={handleCloseDevicePicker}
        >
          <div
            className="remote-device-picker-card"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="remote-device-picker-header">
              <p className="remote-device-picker-title">再生先を選択</p>
              <button
                type="button"
                className="remote-device-picker-close"
                onClick={handleCloseDevicePicker}
                aria-label="close device picker"
              >
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 6l12 12M18 6L6 18"
                  />
                </svg>
              </button>
            </div>
            <div className="remote-device-picker-list">
              {playbackDevices.map((device) => {
                const isSelected = device.id === playbackTarget
                return (
                  <button
                    key={device.id}
                    type="button"
                    className={cn(
                      'remote-device-picker-item',
                      isSelected && 'remote-device-picker-item-active',
                    )}
                    onClick={() => handleSelectPlaybackTarget(device.id)}
                  >
                    <span className="remote-device-picker-item-meta">
                      <span className="remote-device-picker-item-name">
                        {device.name}
                      </span>
                      <span className="remote-device-picker-item-description">
                        {device.description ?? ''}
                      </span>
                    </span>
                    <span className="remote-device-picker-item-check">
                      {isSelected ? '●' : '○'}
                    </span>
                  </button>
                )
              })}
            </div>
            {playbackTarget === 'mobile' && !canStream && (
              <p className="remote-device-picker-note">
                モバイル配信は再生中の song で有効になります
              </p>
            )}
          </div>
        </div>
      )}

      {/* ボトムナビゲーション */}
      <nav className="remote-wave-nav sticky bottom-0 z-50 w-full border-t bg-background">
        <div className="flex h-16 items-center justify-around">
          <button
            onClick={() => handleTabChange('home')}
            className={cn(
              'flex flex-col items-center gap-1 px-3 py-2 text-xs transition-colors',
              activeTab === 'home' ? 'text-primary' : 'text-muted-foreground',
            )}
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M3 11l9-8 9 8v9a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1v-9z"
              />
            </svg>
            ホーム
          </button>

          <button
            onClick={() => handleTabChange('library')}
            className={cn(
              'flex flex-col items-center gap-1 px-3 py-2 text-xs transition-colors',
              activeTab === 'library'
                ? 'text-primary'
                : 'text-muted-foreground',
            )}
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
              />
            </svg>
            ライブラリ
          </button>

          <button
            onClick={() => handleTabChange('queue')}
            className={cn(
              'flex flex-col items-center gap-1 px-3 py-2 text-xs transition-colors',
              activeTab === 'queue' ? 'text-primary' : 'text-muted-foreground',
            )}
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 6h16M4 12h16M4 18h16"
              />
            </svg>
            キュー
          </button>

          <button
            onClick={() => handleTabChange('player')}
            className={cn(
              'flex flex-col items-center gap-1 px-3 py-2 text-xs transition-colors',
              activeTab === 'player' ? 'text-primary' : 'text-muted-foreground',
            )}
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"
              />
            </svg>
            プレイヤー
          </button>

          <button
            onClick={() => handleTabChange('settings')}
            className={cn(
              'flex flex-col items-center gap-1 px-3 py-2 text-xs transition-colors',
              activeTab === 'settings' ? 'text-primary' : 'text-muted-foreground',
            )}
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10.325 4.317a1 1 0 011.35-.447l.905.452a1 1 0 001.063-.122l.82-.657a1 1 0 011.488.214l1.5 2.598a1 1 0 01-.24 1.31l-.737.602a1 1 0 00-.36 1.008l.214.97a1 1 0 00.76.76l.97.214a1 1 0 011.008-.36l.602-.737a1 1 0 011.31-.24l2.598 1.5a1 1 0 01.214 1.488l-.657.82a1 1 0 00-.122 1.063l.452.905a1 1 0 01-.447 1.35l-2.828 1.414a1 1 0 01-1.35-.447l-.452-.905a1 1 0 00-1.063.122l-.82.657a1 1 0 01-1.488-.214l-1.5-2.598a1 1 0 01.24-1.31l.737-.602a1 1 0 00.36-1.008l-.214-.97a1 1 0 00-.76-.76l-.97-.214a1 1 0 00-1.008.36l-.602.737a1 1 0 01-1.31.24l-2.598-1.5a1 1 0 01-.214-1.488l.657-.82a1 1 0 00.122-1.063l-.452-.905a1 1 0 01.447-1.35l2.828-1.414z"
              />
            </svg>
            設定
          </button>
        </div>
      </nav>
    </div>
  )
}
