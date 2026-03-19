import {
  ComponentPropsWithoutRef,
  RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'react-toastify'
import { NativeAudioOutputMode } from '@/platform/contracts/desktop-contract'
import { PlaybackBackend } from '@/playback/backend'
import { NativePlaybackBackend } from '@/playback/backends/native-backend'
import { createSongPlaybackBackend } from '@/playback/backends/song-backend-factory'
import { PlayerAudioPipeline } from '@/playback/pipeline'
import { PlaybackEvent } from '@/playback/session-types'
import {
  usePlayerActions,
  usePlayerIsPlaying,
  usePlayerMediaType,
  useOversamplingState,
  usePlayerVolume,
  useReplayGainActions,
  useReplayGainState,
} from '@/store/player.store'
import { logger } from '@/utils/logger'
import { calculateReplayGain, ReplayGainParams } from '@/utils/replayGain'

type AudioPlayerProps = ComponentPropsWithoutRef<'audio'> & {
  audioRef: RefObject<HTMLAudioElement>
  replayGain?: ReplayGainParams
}

function shouldUseNativeBackendForSong(
  isSong: boolean,
  oversamplingEnabled: boolean,
  outputApi: NativeAudioOutputMode,
): boolean {
  if (!isSong || !oversamplingEnabled) return false

  return outputApi === 'wasapi-shared'
}

export function AudioPlayer({
  audioRef,
  replayGain,
  ...props
}: AudioPlayerProps) {
  const { t } = useTranslation()
  const { replayGainEnabled, replayGainError } = useReplayGainState()
  const {
    enabled: oversamplingEnabled,
    presetId: oversamplingPresetId,
    enginePreference: oversamplingEnginePreference,
    outputApi: oversamplingOutputApi,
    onFailurePolicy: oversamplingOnFailurePolicy,
    capability: oversamplingCapability,
  } = useOversamplingState()
  const { isSong, isRadio, isPodcast } = usePlayerMediaType()
  const { setPlayingState, setCurrentDuration, setProgress, handleSongEnded } =
    usePlayerActions()
  const { setReplayGainEnabled, setReplayGainError } = useReplayGainActions()
  const { volume } = usePlayerVolume()
  const isPlaying = usePlayerIsPlaying()
  const songBackendRef = useRef<PlaybackBackend | null>(null)
  const audioPipelineRef = useRef<PlayerAudioPipeline>(new PlayerAudioPipeline())
  const lastOversamplingFailureRef = useRef<string | null>(null)

  const { src, loop, autoPlay, ...audioProps } = props

  const nativeOutputMode = oversamplingOutputApi as NativeAudioOutputMode
  const useNativeSongBackend = shouldUseNativeBackendForSong(
    isSong,
    oversamplingEnabled,
    nativeOutputMode,
  )
  const useWebAudioSongPath = isSong && !useNativeSongBackend

  const gainValue = useMemo(() => {
    const audioVolume = volume / 100

    if (!replayGain || !replayGainEnabled) {
      return audioVolume * 1
    }
    const gain = calculateReplayGain(replayGain)

    return audioVolume * gain
  }, [replayGain, replayGainEnabled, volume])

  useEffect(() => {
    audioPipelineRef.current.syncAudioTarget({
      audio: audioRef.current,
      isSong: useWebAudioSongPath,
      replayGainError,
    })
  }, [audioRef, useWebAudioSongPath, replayGainError])

  useEffect(() => {
    audioPipelineRef.current.applyReplayGain({
      isSong: useWebAudioSongPath,
      replayGainError,
      gainValue,
    })
  }, [gainValue, useWebAudioSongPath, replayGainError])

  useEffect(() => {
    return () => {
      audioPipelineRef.current.dispose()
      songBackendRef.current?.dispose()
      songBackendRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!useWebAudioSongPath || !oversamplingEnabled) {
      lastOversamplingFailureRef.current = null
      return
    }

    const resolution = audioPipelineRef.current.resolveOversampling(
      {
        enabled: oversamplingEnabled,
        presetId: oversamplingPresetId,
        enginePreference: oversamplingEnginePreference,
        outputApi: oversamplingOutputApi,
        onFailurePolicy: oversamplingOnFailurePolicy,
      },
      oversamplingCapability,
    )

    if (resolution.status !== 'failed') {
      lastOversamplingFailureRef.current = null
      return
    }

    const failureKey = `${resolution.error.code}:${resolution.error.message}`

    if (lastOversamplingFailureRef.current !== failureKey) {
      lastOversamplingFailureRef.current = failureKey
      logger.error('[Oversampling] Resolve failed', resolution.error)
      toast.error(
        t('warnings.oversamplingResolveError', {
          reason: resolution.error.message,
        }),
      )
    }

    if (isPlaying) {
      songBackendRef.current?.pause()
      setPlayingState(false)
    }
  }, [
    useWebAudioSongPath,
    isPlaying,
    oversamplingEnabled,
    oversamplingPresetId,
    oversamplingEnginePreference,
    oversamplingOutputApi,
    oversamplingOnFailurePolicy,
    oversamplingCapability,
    setPlayingState,
    t,
  ])

  useEffect(() => {
    const audio = audioRef.current

    if (!isSong || !audio || typeof src !== 'string' || src.length === 0) return

    const nextBackendId = useNativeSongBackend ? 'native' : 'internal'
    const currentBackend = songBackendRef.current

    if (!currentBackend || currentBackend.id !== nextBackendId) {
      currentBackend?.dispose()
      songBackendRef.current = createSongPlaybackBackend({
        audio,
        useNativeBackend: useNativeSongBackend,
        outputMode: nativeOutputMode,
      })
    }

    const backend = songBackendRef.current
    if (!backend) return

    if (backend instanceof NativePlaybackBackend) {
      backend.setOutputMode(nativeOutputMode).catch((error) => {
        logger.error('Native output mode update failed', error)
      })
    }

    backend
      .load({
        src,
        loop,
        autoplay: isPlaying,
      })
      .catch((error) => {
        logger.error('Audio source load failed', error)
      })
  }, [
    audioRef,
    isSong,
    isPlaying,
    loop,
    nativeOutputMode,
    src,
    useNativeSongBackend,
  ])

  useEffect(() => {
    if (!isSong) return

    songBackendRef.current?.setVolume(volume / 100)
  }, [isSong, volume])

  const handleSongError = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return

    logger.error('Audio load error', {
      src: audio.src,
      networkState: audio.networkState,
      readyState: audio.readyState,
      error: audio.error,
    })

    toast.error(t('warnings.songError'))

    if (replayGainEnabled || !replayGainError) {
      setReplayGainEnabled(false)
      setReplayGainError(true)
      window.location.reload()
    }
  }, [
    audioRef,
    replayGainEnabled,
    replayGainError,
    setReplayGainEnabled,
    setReplayGainError,
    t,
  ])

  const handleRadioError = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return

    toast.error(t('radios.error'))
    setPlayingState(false)
  }, [audioRef, setPlayingState, t])

  useEffect(() => {
    if (!isSong) return

    const backend = songBackendRef.current
    if (!backend) return

    const handleEvent = (event: PlaybackEvent) => {
      const { type, snapshot } = event

      if (type === 'loadedmetadata') {
        setCurrentDuration(Math.floor(snapshot.durationSeconds))
        return
      }

      if (type === 'timeupdate') {
        setProgress(Math.floor(snapshot.currentTimeSeconds))
        return
      }

      if (type === 'play') {
        setPlayingState(true)
        return
      }

      if (type === 'pause' && snapshot.status !== 'ended') {
        setPlayingState(false)
        return
      }

      if (type === 'ended') {
        handleSongEnded()
        return
      }

      if (type === 'error') {
        handleSongError()
      }
    }

    return backend.subscribe(handleEvent)
  }, [
    handleSongEnded,
    handleSongError,
    isSong,
    setCurrentDuration,
    setPlayingState,
    setProgress,
  ])

  useEffect(() => {
    async function handleSong() {
      const backend = songBackendRef.current
      if (!backend) return

      try {
        if (isPlaying) {
          if (useWebAudioSongPath) {
            await audioPipelineRef.current.resumeIfNeeded()
          }
          await backend.play()
        } else {
          backend.pause()
        }
      } catch (error) {
        logger.error('Audio playback failed', error)
        handleSongError()
      }
    }

    async function handlePodcast() {
      const audio = audioRef.current
      if (!audio) return

      try {
        if (isPlaying) {
          await audio.play()
        } else {
          audio.pause()
        }
      } catch (error) {
        logger.error('Audio playback failed', error)
        handleSongError()
      }
    }

    if (isSong) {
      handleSong()
      return
    }

    if (isPodcast) {
      handlePodcast()
    }
  }, [
    audioRef,
    handleSongError,
    isPlaying,
    isSong,
    isPodcast,
    useWebAudioSongPath,
  ])

  useEffect(() => {
    async function handleRadio() {
      const audio = audioRef.current
      if (!audio) return

      if (isPlaying) {
        audio.load()
        await audio.play()
      } else {
        audio.pause()
      }
    }
    if (isRadio) handleRadio()
  }, [audioRef, isPlaying, isRadio])

  const handleError = useMemo(() => {
    if (isSong) return handleSongError
    if (isRadio) return handleRadioError

    return undefined
  }, [handleRadioError, handleSongError, isRadio, isSong])

  const crossOrigin = useMemo(() => {
    if (!useWebAudioSongPath || replayGainError) return undefined

    return 'anonymous'
  }, [replayGainError, useWebAudioSongPath])

  return (
    <audio
      ref={audioRef}
      {...audioProps}
      src={isSong ? undefined : src}
      loop={loop}
      autoPlay={isSong ? undefined : autoPlay}
      crossOrigin={crossOrigin}
      onError={handleError}
    />
  )
}
