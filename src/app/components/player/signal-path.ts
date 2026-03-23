import { QueueItem } from '@/domain/entities/queue-item'
import {
  OversamplingCapability,
  OversamplingOutputApi,
  OversamplingSettingsValues,
  resolveOversamplingConfig,
} from '@/oversampling'

export type SignalPathQuality = 'lossless' | 'enhanced' | 'lossy' | 'warning'

type SignalPathStageId = 'source' | 'engine' | 'dsp' | 'output'

export interface SignalPathStage {
  id: SignalPathStageId
  titleKey: string
  description: string
}

export interface SignalPathModel {
  quality: SignalPathQuality
  stages: SignalPathStage[]
}

interface BuildSignalPathParams {
  currentQueueItem: QueueItem | null
  oversampling: OversamplingSettingsValues & {
    capability: OversamplingCapability
  }
  nativeAudioApiAvailable: boolean
}

const stageTitleKeys: Record<SignalPathStageId, string> = {
  source: 'player.signalPath.stages.source.title',
  engine: 'player.signalPath.stages.engine.title',
  dsp: 'player.signalPath.stages.dsp.title',
  output: 'player.signalPath.stages.output.title',
}

const sourceLabels: Record<QueueItem['source'], string> = {
  navidrome: 'Navidrome',
  spotify: 'Spotify',
  local: 'Local Library',
  'apple-music': 'Apple Music',
}

const outputApiLabels: Record<OversamplingOutputApi, string> = {
  'wasapi-shared': 'WASAPI Shared',
  'wasapi-exclusive': 'WASAPI Exclusive',
  asio: 'ASIO',
}

const losslessSuffixes = new Set([
  'flac',
  'wav',
  'wave',
  'aif',
  'aiff',
  'alac',
  'ape',
  'wv',
  'dsf',
  'dff',
])

const lossySuffixes = new Set([
  'mp3',
  'aac',
  'm4a',
  'ogg',
  'oga',
  'opus',
  'wma',
  'mp2',
])

function isDirectOutputApi(outputApi: OversamplingOutputApi): boolean {
  return outputApi === 'wasapi-exclusive' || outputApi === 'asio'
}

function formatSampleRate(value?: number): string | null {
  if (!value || value <= 0) return null

  const kiloHertz = value / 1000
  return `${Number.isInteger(kiloHertz) ? kiloHertz : kiloHertz.toFixed(1)}kHz`
}

function formatBitDepth(value?: number): string | null {
  if (!value || value <= 0) return null

  return `${value}bit`
}

function formatChannels(value?: number): string | null {
  if (!value || value <= 0) return null

  return `${value}ch`
}

function inferCodecLabel(track: QueueItem['track']): string {
  const suffix = track.suffix?.trim()
  if (suffix) return suffix.toUpperCase()

  const contentType = track.contentType?.toLowerCase().trim()
  if (!contentType) return 'Unknown'
  if (contentType.includes('flac')) return 'FLAC'
  if (contentType.includes('wav')) return 'WAV'
  if (contentType.includes('aiff')) return 'AIFF'
  if (contentType.includes('mpeg')) return 'MP3'
  if (contentType.includes('ogg')) return 'OGG'
  if (contentType.includes('aac')) return 'AAC'
  if (contentType.includes('mp4')) return 'M4A/ALAC'

  return contentType.replace('audio/', '').toUpperCase()
}

function getTrackFidelity(
  track: QueueItem['track'],
): 'lossless' | 'lossy' | 'unknown' {
  const suffix = track.suffix?.toLowerCase().trim()

  if (suffix) {
    if (losslessSuffixes.has(suffix)) return 'lossless'
    if (lossySuffixes.has(suffix)) return 'lossy'
  }

  const contentType = track.contentType?.toLowerCase().trim()
  if (!contentType) return 'unknown'

  if (
    contentType.includes('flac') ||
    contentType.includes('wav') ||
    contentType.includes('aiff')
  ) {
    return 'lossless'
  }

  if (
    contentType.includes('mpeg') ||
    contentType.includes('ogg') ||
    contentType.includes('aac')
  ) {
    return 'lossy'
  }

  if (contentType.includes('mp4') && suffix === 'alac') {
    return 'lossless'
  }

  return 'unknown'
}

function formatTargetRatePolicy(policy: OversamplingSettingsValues['targetRatePolicy']): string {
  const labels: Record<OversamplingSettingsValues['targetRatePolicy'], string> =
    {
      'integer-family-max': 'Auto',
      'fixed-88200': '88.2kHz',
      'fixed-96000': '96kHz',
      'fixed-176400': '176.4kHz',
      'fixed-192000': '192kHz',
      'fixed-352800': '352.8kHz',
      'fixed-384000': '384kHz',
      'fixed-705600': '705.6kHz',
      'fixed-768000': '768kHz',
      'fixed-1411200': '1411.2kHz',
      'fixed-1536000': '1536kHz',
    }

  return labels[policy]
}

export function buildSignalPath({
  currentQueueItem,
  oversampling,
  nativeAudioApiAvailable,
}: BuildSignalPathParams): SignalPathModel {
  if (!currentQueueItem) {
    return {
      quality: 'warning',
      stages: [
        {
          id: 'source',
          titleKey: stageTitleKeys.source,
          description: 'No track loaded',
        },
        {
          id: 'engine',
          titleKey: stageTitleKeys.engine,
          description: 'Unknown',
        },
        {
          id: 'dsp',
          titleKey: stageTitleKeys.dsp,
          description: 'Unknown',
        },
        {
          id: 'output',
          titleKey: stageTitleKeys.output,
          description: 'Unknown',
        },
      ],
    }
  }

  const sourceLabel = sourceLabels[currentQueueItem.source]
  const codecLabel = inferCodecLabel(currentQueueItem.track)
  const sampleRateLabel = formatSampleRate(currentQueueItem.track.samplingRate)
  const bitDepthLabel = formatBitDepth(currentQueueItem.track.bitDepth)
  const channelLabel = formatChannels(currentQueueItem.track.channelCount)
  const sourceDescription = [
    sourceLabel,
    codecLabel,
    sampleRateLabel,
    bitDepthLabel,
    channelLabel,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' / ')

  const oversamplingResolveResult = oversampling.enabled
    ? resolveOversamplingConfig(oversampling, oversampling.capability)
    : null
  const outputApiSupported =
    oversampling.capability.supportedOutputApis.includes(oversampling.outputApi)
  const nativePathRequested =
    oversampling.enabled &&
    outputApiSupported &&
    isDirectOutputApi(oversampling.outputApi)
  const usesNativeBackend =
    currentQueueItem.playbackBackend === 'native' ||
    (nativeAudioApiAvailable && nativePathRequested)

  const engineDescription = usesNativeBackend
    ? 'Native Playback Backend'
    : 'Internal Playback Backend'

  const dspDescription = (() => {
    if (!oversampling.enabled) {
      return 'Disabled'
    }

    if (!oversamplingResolveResult || !oversamplingResolveResult.ok) {
      const errorCode = oversamplingResolveResult?.error.code ?? 'unknown'
      return `Oversampling (resolve error: ${errorCode})`
    }

    return `Oversampling (${oversamplingResolveResult.value.preset.displayName} / ${oversamplingResolveResult.value.selectedEngine.toUpperCase()} / ${formatTargetRatePolicy(oversampling.targetRatePolicy)})`
  })()

  const outputDescription = (() => {
    if (usesNativeBackend && isDirectOutputApi(oversampling.outputApi)) {
      return outputApiLabels[oversampling.outputApi]
    }

    if (nativePathRequested && !nativeAudioApiAvailable) {
      return `${outputApiLabels[oversampling.outputApi]} -> System Shared (fallback)`
    }

    return 'System Shared (Internal/WebAudio)'
  })()

  const sourceFidelity = getTrackFidelity(currentQueueItem.track)
  const quality: SignalPathQuality = (() => {
    if (oversampling.enabled && oversamplingResolveResult && !oversamplingResolveResult.ok) {
      return 'warning'
    }

    if (oversampling.enabled && oversamplingResolveResult?.ok) {
      return 'enhanced'
    }

    const directOutput =
      usesNativeBackend && isDirectOutputApi(oversampling.outputApi)

    if (directOutput && sourceFidelity === 'lossless') {
      return 'lossless'
    }

    if (!directOutput || sourceFidelity === 'lossy') {
      return 'lossy'
    }

    return 'warning'
  })()

  return {
    quality,
    stages: [
      {
        id: 'source',
        titleKey: stageTitleKeys.source,
        description: sourceDescription,
      },
      {
        id: 'engine',
        titleKey: stageTitleKeys.engine,
        description: engineDescription,
      },
      {
        id: 'dsp',
        titleKey: stageTitleKeys.dsp,
        description: dspDescription,
      },
      {
        id: 'output',
        titleKey: stageTitleKeys.output,
        description: outputDescription,
      },
    ],
  }
}
