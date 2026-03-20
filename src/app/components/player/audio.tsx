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
import {
  createRuntimeOversamplingCapability,
  OVERSAMPLING_PROCESSING_OUTPUT_APIS,
  OversamplingCapability,
  OversamplingTargetRatePolicy,
} from '@/oversampling'
import { PlaybackBackend } from '@/playback/backend'
import { NativePlaybackBackend } from '@/playback/backends/native-backend'
import { createSongPlaybackBackend } from '@/playback/backends/song-backend-factory'
import { PlayerAudioPipeline } from '@/playback/pipeline'
import { PlaybackEvent } from '@/playback/session-types'
import {
  usePlayerActions,
  usePlayerIsPlaying,
  usePlayerMediaType,
  useOversamplingActions,
  useOversamplingState,
  useParametricEqActions,
  useParametricEqState,
  usePlayerVolume,
  useReplayGainActions,
  useReplayGainState,
} from '@/store/player.store'
import { setCurrentSongSeekHandler } from '@/store/song-seek-registry'
import { logger } from '@/utils/logger'
import { calculateReplayGain, ReplayGainParams } from '@/utils/replayGain'

type AudioPlayerProps = ComponentPropsWithoutRef<'audio'> & {
  audioRef: RefObject<HTMLAudioElement>
  replayGain?: ReplayGainParams
  durationSeconds?: number
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`
  }

  if (typeof error === 'object' && error !== null) {
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }

  return String(error)
}

function hasNativeAudioApi(): boolean {
  if (typeof window === 'undefined') return false

  const api = (
    window as Window & { api?: { nativeAudioInitialize?: unknown } }
  ).api
  return typeof api?.nativeAudioInitialize === 'function'
}

function resolveTargetSampleRateHz(
  policy: OversamplingTargetRatePolicy,
): number | undefined {
  switch (policy) {
    case 'fixed-88200':
      return 88200
    case 'fixed-96000':
      return 96000
    case 'fixed-176400':
      return 176400
    case 'fixed-192000':
      return 192000
    case 'fixed-352800':
      return 352800
    case 'fixed-384000':
      return 384000
    case 'fixed-705600':
      return 705600
    case 'fixed-768000':
      return 768000
    case 'fixed-1411200':
      return 1411200
    case 'fixed-1536000':
      return 1536000
    case 'integer-family-max':
    default:
      return undefined
  }
}

function shouldUseNativeBackendForSong(
  isSong: boolean,
  oversamplingEnabled: boolean,
  parametricEqEnabled: boolean,
  nativeApiAvailable: boolean,
  outputApi: NativeAudioOutputMode,
  outputApiSupported: boolean,
): boolean {
  if (!isSong || !nativeApiAvailable) {
    return false
  }

  if (parametricEqEnabled) {
    return true
  }

  if (!oversamplingEnabled || !outputApiSupported) {
    return false
  }

  return outputApi === 'wasapi-exclusive' || outputApi === 'asio'
}

function areStringArraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false

  return a.every((value, index) => value === b[index])
}

function areCapabilitiesEqual(
  current: OversamplingCapability,
  next: OversamplingCapability,
): boolean {
  if (
    !areStringArraysEqual(
      current.supportedOutputApis,
      next.supportedOutputApis,
    )
  ) {
    return false
  }

  if (!areStringArraysEqual(current.availableEngines, next.availableEngines)) {
    return false
  }

  const engines = [...new Set([...current.availableEngines, ...next.availableEngines])]

  return engines.every(
    (engine) =>
      (current.maxTapCountByEngine?.[engine] ?? null) ===
      (next.maxTapCountByEngine?.[engine] ?? null),
  )
}

export function AudioPlayer({
  audioRef,
  replayGain,
  durationSeconds: _durationSeconds,
  ...props
}: AudioPlayerProps) {
  const { t } = useTranslation()
  const { replayGainEnabled, replayGainError } = useReplayGainState()
  const {
    enabled: oversamplingEnabled,
    presetId: oversamplingPresetId,
    targetRatePolicy: oversamplingTargetRatePolicy,
    enginePreference: oversamplingEnginePreference,
    outputApi: oversamplingOutputApi,
    onFailurePolicy: oversamplingOnFailurePolicy,
    capability: oversamplingCapability,
  } = useOversamplingState()
  const {
    enabled: parametricEqEnabled,
    profile: parametricEqProfile,
  } = useParametricEqState()
  const { isSong, isRadio, isPodcast } = usePlayerMediaType()
  const { setPlayingState, setCurrentDuration, setProgress, handleSongEnded } =
    usePlayerActions()
  const { setCapability, setEnabled, setEnginePreference, setOutputApi } =
    useOversamplingActions()
  const { setParametricEqEnabled } = useParametricEqActions()
  const { setReplayGainEnabled, setReplayGainError } = useReplayGainActions()
  const { volume } = usePlayerVolume()
  const isPlaying = usePlayerIsPlaying()
  const isPlayingRef = useRef(isPlaying)
  isPlayingRef.current = isPlaying
  const songBackendRef = useRef<PlaybackBackend | null>(null)
  const audioPipelineRef = useRef<PlayerAudioPipeline>(new PlayerAudioPipeline())
  const lastOversamplingFailureRef = useRef<string | null>(null)

  const { src, loop, autoPlay, ...audioProps } = props

  const nativeApiAvailable = hasNativeAudioApi()

  const nativeOutputMode = (parametricEqEnabled
    ? 'wasapi-exclusive'
    : oversamplingOutputApi) as NativeAudioOutputMode
  const oversamplingTargetSampleRateHz = oversamplingEnabled
    ? resolveTargetSampleRateHz(oversamplingTargetRatePolicy)
    : undefined
  const oversamplingFilterId = oversamplingEnabled
    ? oversamplingPresetId
    : undefined
  const isSelectedOutputApiSupported =
    oversamplingCapability.supportedOutputApis.includes(oversamplingOutputApi)
  const useNativeSongBackend = shouldUseNativeBackendForSong(
    isSong,
    oversamplingEnabled,
    parametricEqEnabled,
    nativeApiAvailable,
    nativeOutputMode,
    isSelectedOutputApiSupported,
  )
  const parametricEqLoadConfig = useMemo(() => {
    if (!parametricEqEnabled || !parametricEqProfile) {
      return undefined
    }

    return {
      preampDb: parametricEqProfile.preampDb,
      bands: parametricEqProfile.bands.map((band) => ({
        enabled: band.enabled,
        type: band.type,
        frequencyHz: band.frequencyHz,
        gainDb: band.gainDb,
        q: band.q,
      })),
    }
  }, [parametricEqEnabled, parametricEqProfile])
  const shouldApplyParametricEq = Boolean(
    parametricEqLoadConfig && nativeOutputMode === 'wasapi-exclusive',
  )
  const parametricEqForLoad = shouldApplyParametricEq
    ? parametricEqLoadConfig
    : undefined
  const useWebAudioSongPath = isSong && !useNativeSongBackend
  const shouldAttachWebAudioGraph =
    useWebAudioSongPath && (replayGainEnabled || oversamplingEnabled)

  useEffect(() => {
    const api =
      typeof window !== 'undefined' ? (window as Window & { api?: unknown }).api : null
    if (
      !api ||
      typeof api !== 'object' ||
      !('nativeAudioListDevices' in api) ||
      typeof api.nativeAudioListDevices !== 'function'
    ) {
      return
    }

    let cancelled = false

    async function syncCapabilityFromNativeDevices(): Promise<void> {
      try {
        const nativeApi = api as {
          nativeAudioListDevices: () => Promise<
            Array<{ mode: NativeAudioOutputMode }>
          >
        }
        const devices = await nativeApi.nativeAudioListDevices()
        if (cancelled) return

        const supportedOutputApis = OVERSAMPLING_PROCESSING_OUTPUT_APIS.filter(
          (mode) => devices.some((device) => device.mode === mode),
        )
        const nextCapability = createRuntimeOversamplingCapability({
          supportedOutputApis,
          availableEngines: ['cpu'],
        })

        if (!areCapabilitiesEqual(oversamplingCapability, nextCapability)) {
          setCapability(nextCapability)
        }

        if (!nextCapability.supportedOutputApis.includes(oversamplingOutputApi)) {
          const fallbackOutputApi = nextCapability.supportedOutputApis[0]
          if (fallbackOutputApi) {
            setOutputApi(fallbackOutputApi)
          } else if (oversamplingEnabled) {
            logger.warn(
              '[Oversampling] No exclusive/direct output API is available. Disabling oversampling.',
            )
            setEnabled(false)
          }
        }

        if (
          oversamplingEnginePreference !== 'auto' &&
          !nextCapability.availableEngines.includes(oversamplingEnginePreference)
        ) {
          setEnginePreference(nextCapability.availableEngines[0] ?? 'auto')
        }
      } catch (error) {
        logger.warn('Failed to sync oversampling capability from native devices', {
          error,
        })
      }
    }

    syncCapabilityFromNativeDevices()

    return () => {
      cancelled = true
    }
  }, [
    oversamplingCapability,
    oversamplingEnabled,
    oversamplingEnginePreference,
    oversamplingOutputApi,
    setCapability,
    setEnabled,
    setEnginePreference,
    setOutputApi,
  ])

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
      isSong: shouldAttachWebAudioGraph,
      replayGainError,
    })
  }, [audioRef, shouldAttachWebAudioGraph, replayGainError])

  useEffect(() => {
    audioPipelineRef.current.applyReplayGain({
      isSong: useWebAudioSongPath,
      replayGainError,
      gainValue,
    })
  }, [gainValue, useWebAudioSongPath, replayGainError])

  useEffect(() => {
    return () => {
      setCurrentSongSeekHandler(null)
      audioPipelineRef.current.dispose()
      songBackendRef.current?.dispose()
      songBackendRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!isSong) {
      setCurrentSongSeekHandler(null)
      return
    }

    setCurrentSongSeekHandler((positionSeconds) => {
      songBackendRef.current?.seek(positionSeconds)
    })

    return () => {
      setCurrentSongSeekHandler(null)
    }
  }, [isSong])

  useEffect(() => {
    if (!useWebAudioSongPath || !oversamplingEnabled) {
      lastOversamplingFailureRef.current = null
      return
    }

    const resolution = audioPipelineRef.current.resolveOversampling(
      {
        enabled: oversamplingEnabled,
        presetId: oversamplingPresetId,
        targetRatePolicy: oversamplingTargetRatePolicy,
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
    oversamplingTargetRatePolicy,
    oversamplingEnginePreference,
    oversamplingOutputApi,
    oversamplingOnFailurePolicy,
    oversamplingCapability,
    setPlayingState,
    t,
  ])

  const handleSongError = useCallback(
    ({
      native = false,
      reason,
    }: {
      native?: boolean
      reason?: unknown
    } = {}) => {
      if (reason !== undefined) {
        logger.error('Song playback error detail', describeError(reason))
      }

      if (native || useNativeSongBackend) {
        toast.error(t('warnings.songError'))
        setPlayingState(false)
        return
      }

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
    },
    [
      audioRef,
      replayGainEnabled,
      replayGainError,
      setPlayingState,
      setReplayGainEnabled,
      setReplayGainError,
      t,
      useNativeSongBackend,
    ],
  )

  useEffect(() => {
    const audio = audioRef.current

    if (!isSong || !audio || typeof src !== 'string' || src.length === 0) return

    let cancelled = false

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

    async function configureAndLoadSong(): Promise<void> {
      try {
        if (backend instanceof NativePlaybackBackend) {
          await backend.setOutputMode(nativeOutputMode)
          const resolvedMode = backend.getOutputMode()
          if (!cancelled && resolvedMode !== nativeOutputMode) {
            setOutputApi(resolvedMode)
            if (resolvedMode === 'wasapi-shared' && oversamplingEnabled) {
              setEnabled(false)
            }
            if (resolvedMode === 'wasapi-shared' && parametricEqEnabled) {
              setParametricEqEnabled(false)
              toast.warn(t('settings.audio.parametricEq.runtime.exclusiveOnly'))
            }
          }
        }

        if (cancelled) return

        await backend.load({
          src,
          loop,
          autoplay: isPlayingRef.current,
          targetSampleRateHz: oversamplingTargetSampleRateHz,
          oversamplingFilterId,
          parametricEq: parametricEqForLoad,
        })

        if (backend instanceof NativePlaybackBackend) {
          const resolvedMode = backend.getOutputMode()
          if (!cancelled && resolvedMode !== nativeOutputMode) {
            setOutputApi(resolvedMode)
            if (resolvedMode === 'wasapi-shared' && oversamplingEnabled) {
              setEnabled(false)
            }
            if (resolvedMode === 'wasapi-shared' && parametricEqEnabled) {
              setParametricEqEnabled(false)
              toast.warn(t('settings.audio.parametricEq.runtime.exclusiveOnly'))
            }
          }
        }
      } catch (error) {
        if (cancelled) return

        logger.error('Audio source load failed', describeError(error))

        if (!(backend instanceof NativePlaybackBackend)) {
          handleSongError({ reason: error })
          return
        }

        try {
          await backend.setOutputMode('wasapi-shared')

          if (cancelled) return

          if (nativeOutputMode === 'wasapi-exclusive') {
            setOutputApi('wasapi-shared')
            if (oversamplingEnabled) {
              setEnabled(false)
            }
            if (parametricEqEnabled) {
              setParametricEqEnabled(false)
              toast.warn(t('settings.audio.parametricEq.runtime.exclusiveOnly'))
            }
          }

          await backend.load({
            src,
            loop,
            autoplay: isPlayingRef.current,
            targetSampleRateHz: oversamplingTargetSampleRateHz,
            oversamplingFilterId,
            parametricEq: undefined,
          })

          if (backend instanceof NativePlaybackBackend) {
            const resolvedMode = backend.getOutputMode()
            if (!cancelled && resolvedMode !== nativeOutputMode) {
              setOutputApi(resolvedMode)
              if (resolvedMode === 'wasapi-shared' && oversamplingEnabled) {
                setEnabled(false)
              }
              if (resolvedMode === 'wasapi-shared' && parametricEqEnabled) {
                setParametricEqEnabled(false)
                toast.warn(t('settings.audio.parametricEq.runtime.exclusiveOnly'))
              }
            }
          }
        } catch (fallbackError) {
          if (cancelled) return

          logger.error(
            'Audio source load retry failed after shared fallback',
            describeError(fallbackError),
          )
          handleSongError({
            native: true,
            reason: fallbackError,
          })
        }
      }
    }

    configureAndLoadSong().catch((error) => {
      logger.error('configureAndLoadSong failed', describeError(error))
    })

    return () => {
      cancelled = true
    }
  }, [
    audioRef,
    handleSongError,
    isSong,
    loop,
    nativeOutputMode,
    oversamplingEnabled,
    oversamplingFilterId,
    oversamplingTargetSampleRateHz,
    parametricEqEnabled,
    parametricEqForLoad,
    setEnabled,
    setParametricEqEnabled,
    setOutputApi,
    src,
    t,
    useNativeSongBackend,
  ])
  useEffect(() => {
    if (!isSong) return

    songBackendRef.current?.setVolume(volume / 100)
  }, [isSong, volume])

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
        if (backend instanceof NativePlaybackBackend) {
          logger.warn(
            '[NativePlaybackBackend] Ignoring transient backend error event during recovery',
            describeError(snapshot.error),
          )
          return
        }

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

          if (backend instanceof NativePlaybackBackend) {
            const resolvedMode = backend.getOutputMode()
            if (resolvedMode !== nativeOutputMode) {
              setOutputApi(resolvedMode)
            }
          }
        } else {
          const snapshot = backend.getSnapshot()
          if (snapshot.isPlaying || snapshot.status === 'playing') {
            backend.pause()
          }
        }
      } catch (error) {
        logger.error('Audio playback failed', describeError(error))
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
        logger.error('Audio playback failed', describeError(error))
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
    nativeOutputMode,
    setOutputApi,
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
    if (isSong && useWebAudioSongPath) return handleSongError
    if (isRadio) return handleRadioError

    return undefined
  }, [handleRadioError, handleSongError, isRadio, isSong, useWebAudioSongPath])

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
