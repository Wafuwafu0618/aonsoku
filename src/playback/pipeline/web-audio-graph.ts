import {
  AudioContext,
  type IAudioContext,
  type IGainNode,
  type IMediaElementAudioSourceNode,
} from 'standardized-audio-context'
import { logger } from '@/utils/logger'
import { GraphDspEffectDefinition, GraphDspInstance } from './oversampling-dsp'

type AudioSource = IMediaElementAudioSourceNode<IAudioContext>

function isValidGain(gainValue: number): boolean {
  return Number.isFinite(gainValue) && !Number.isNaN(gainValue) && gainValue > 0
}

export class WebAudioGraph {
  private audioContextRef: IAudioContext | null = null
  private sourceNodeRef: AudioSource | null = null
  private gainNodeRef: IGainNode<IAudioContext> | null = null
  private attachedAudio: HTMLAudioElement | null = null
  private previousGainValue = 1
  private dspEffectDefinition: GraphDspEffectDefinition | null = null
  private activeDspInstance: GraphDspInstance | null = null

  setDspEffect(effectDefinition: GraphDspEffectDefinition | null): void {
    const previousKey = this.dspEffectDefinition?.key ?? null
    const nextKey = effectDefinition?.key ?? null

    this.dspEffectDefinition = effectDefinition

    if (previousKey === nextKey) {
      return
    }

    this.rebuildGraphConnections()
  }

  attach(audio: HTMLAudioElement): void {
    if (this.attachedAudio === audio && this.gainNodeRef && this.audioContextRef) {
      return
    }

    this.dispose()

    try {
      this.audioContextRef = new AudioContext()
      this.sourceNodeRef = this.audioContextRef.createMediaElementSource(audio)
      this.gainNodeRef = this.audioContextRef.createGain()

      this.rebuildGraphConnections()

      this.attachedAudio = audio
      this.previousGainValue = 1
    } catch (error) {
      logger.error('[PlaybackPipeline] Failed to attach WebAudio graph', error)
      this.dispose()
    }
  }

  async resume(): Promise<void> {
    const audioContext = this.audioContextRef
    if (!audioContext) return

    if (audioContext.state === 'suspended') {
      await audioContext.resume()
      return
    }

    if (audioContext.state === 'closed' && this.attachedAudio) {
      this.attach(this.attachedAudio)
    }
  }

  setGain(gainValue: number): void {
    if (!this.audioContextRef || !this.gainNodeRef) return
    if (!isValidGain(gainValue)) return
    if (this.previousGainValue === gainValue) return

    this.gainNodeRef.gain.setValueAtTime(
      gainValue,
      this.audioContextRef.currentTime,
    )
    this.previousGainValue = gainValue
  }

  dispose(): void {
    if (this.sourceNodeRef) {
      this.sourceNodeRef.disconnect()
      this.sourceNodeRef = null
    }

    this.disposeActiveDspInstance()

    if (this.gainNodeRef) {
      this.gainNodeRef.disconnect()
      this.gainNodeRef = null
    }

    if (this.audioContextRef) {
      this.audioContextRef.close().catch((error) => {
        logger.error('[PlaybackPipeline] Failed to close WebAudio context', error)
      })
      this.audioContextRef = null
    }

    this.attachedAudio = null
    this.previousGainValue = 1
  }

  private rebuildGraphConnections(): void {
    if (!this.sourceNodeRef || !this.gainNodeRef || !this.audioContextRef) {
      return
    }

    this.sourceNodeRef.disconnect()
    this.gainNodeRef.disconnect()
    this.disposeActiveDspInstance()

    if (this.dspEffectDefinition) {
      this.activeDspInstance = this.dspEffectDefinition.create(this.audioContextRef)
      this.sourceNodeRef.connect(this.activeDspInstance.input as never)
      this.activeDspInstance.output.connect(this.gainNodeRef as never)
    } else {
      this.sourceNodeRef.connect(this.gainNodeRef)
    }

    this.gainNodeRef.connect(this.audioContextRef.destination)
  }

  private disposeActiveDspInstance(): void {
    if (!this.activeDspInstance) return

    try {
      this.activeDspInstance.input.disconnect()
      if (this.activeDspInstance.output !== this.activeDspInstance.input) {
        this.activeDspInstance.output.disconnect()
      }
      this.activeDspInstance.dispose?.()
    } catch (error) {
      logger.error('[PlaybackPipeline] Failed to dispose DSP nodes', error)
    } finally {
      this.activeDspInstance = null
    }
  }
}
