import {
  ComponentPropsWithoutRef,
  RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'react-toastify'
import { useAudioContext } from '@/app/hooks/use-audio-context'
import { InternalPlaybackBackend } from '@/playback/backends/internal-backend'
import { PlaybackEvent } from '@/playback/session-types'
import {
  usePlayerActions,
  usePlayerIsPlaying,
  usePlayerMediaType,
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

export function AudioPlayer({
  audioRef,
  replayGain,
  ...props
}: AudioPlayerProps) {
  const { t } = useTranslation()
  const [previousGain, setPreviousGain] = useState(1)
  const { replayGainEnabled, replayGainError } = useReplayGainState()
  const { isSong, isRadio, isPodcast } = usePlayerMediaType()
  const { setPlayingState, setCurrentDuration, setProgress, handleSongEnded } =
    usePlayerActions()
  const { setReplayGainEnabled, setReplayGainError } = useReplayGainActions()
  const { volume } = usePlayerVolume()
  const isPlaying = usePlayerIsPlaying()
  const songBackendRef = useRef<InternalPlaybackBackend | null>(null)

  const { src, loop, autoPlay, ...audioProps } = props

  const gainValue = useMemo(() => {
    const audioVolume = volume / 100

    if (!replayGain || !replayGainEnabled) {
      return audioVolume * 1
    }
    const gain = calculateReplayGain(replayGain)

    return audioVolume * gain
  }, [replayGain, replayGainEnabled, volume])

  const { resumeContext, setupGain } = useAudioContext(audioRef.current)

  const ignoreGain = !isSong || replayGainError

  useEffect(() => {
    if (ignoreGain || !audioRef.current) return

    if (gainValue === previousGain) return

    setupGain(gainValue, replayGain)
    setPreviousGain(gainValue)
  }, [audioRef, ignoreGain, gainValue, previousGain, replayGain, setupGain])

  useEffect(() => {
    return () => {
      songBackendRef.current?.dispose()
      songBackendRef.current = null
    }
  }, [])

  useEffect(() => {
    const audio = audioRef.current

    if (!isSong || !audio || typeof src !== 'string' || src.length === 0) return

    if (!songBackendRef.current) {
      songBackendRef.current = new InternalPlaybackBackend(audio)
    }

    songBackendRef.current
      .load({
        src,
        loop,
        autoplay: false,
      })
      .catch((error) => {
        logger.error('Audio source load failed', error)
      })
  }, [audioRef, isSong, loop, src])

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
          await resumeContext()
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
  }, [audioRef, handleSongError, isPlaying, isSong, isPodcast, resumeContext])

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
    if (!isSong || replayGainError) return undefined

    return 'anonymous'
  }, [isSong, replayGainError])

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
