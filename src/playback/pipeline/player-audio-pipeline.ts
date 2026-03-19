import {
  resolveOversamplingConfig,
  OversamplingCapability,
  OversamplingResolveFailure,
  OversamplingSettingsValues,
  ResolvedOversamplingConfig,
} from '@/oversampling'
import { createOversamplingDspEffectDefinition } from './oversampling-dsp'
import { WebAudioGraph } from './web-audio-graph'

export interface ReplayGainInput {
  isSong: boolean
  replayGainError: boolean
  gainValue: number
}

export interface AudioTargetInput {
  audio: HTMLAudioElement | null
  isSong: boolean
  replayGainError: boolean
}

export type OversamplingResolution =
  | { status: 'disabled' }
  | { status: 'resolved'; config: ResolvedOversamplingConfig }
  | { status: 'failed'; error: OversamplingResolveFailure }

export class PlayerAudioPipeline {
  private readonly graph = new WebAudioGraph()

  syncAudioTarget({ audio, isSong, replayGainError }: AudioTargetInput): void {
    if (!audio || !isSong || replayGainError) {
      this.graph.dispose()
      return
    }

    this.graph.attach(audio)
  }

  async resumeIfNeeded(): Promise<void> {
    await this.graph.resume()
  }

  applyReplayGain({ isSong, replayGainError, gainValue }: ReplayGainInput): void {
    if (!isSong || replayGainError) return

    this.graph.setGain(gainValue)
  }

  resolveOversampling(
    settings: OversamplingSettingsValues,
    capability: OversamplingCapability,
  ): OversamplingResolution {
    if (!settings.enabled) {
      this.graph.setDspEffect(null)
      return { status: 'disabled' }
    }

    const result = resolveOversamplingConfig(settings, capability)
    if (!result.ok) {
      this.graph.setDspEffect(null)
      return { status: 'failed', error: result.error }
    }

    this.graph.setDspEffect(createOversamplingDspEffectDefinition(result.value))

    return { status: 'resolved', config: result.value }
  }

  dispose(): void {
    this.graph.dispose()
  }
}
