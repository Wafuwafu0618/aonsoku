import { IAudioContext } from 'standardized-audio-context'
import { ResolvedOversamplingConfig } from '@/oversampling'

export interface GraphNodeLike {
  connect: (destinationNode: unknown) => unknown
  disconnect: () => void
}

export interface GraphDspInstance {
  input: GraphNodeLike
  output: GraphNodeLike
  dispose?: () => void
}

export interface GraphDspEffectDefinition {
  key: string
  create: (context: IAudioContext) => GraphDspInstance
}

interface FilterKernelSpec {
  taps: number
  cutoff: number
}

const FILTER_KERNEL_SPECS: Record<string, FilterKernelSpec> = {
  'fir-lp': {
    taps: 511,
    cutoff: 0.476,
  },
  'fir-mp': {
    taps: 511,
    cutoff: 0.475,
  },
  'fir-asym': {
    taps: 511,
    cutoff: 0.475,
  },
  'fir-minring-lp': {
    taps: 511,
    cutoff: 0.476,
  },
  'fir-minring-mp': {
    taps: 511,
    cutoff: 0.475,
  },
  fft: {
    taps: 1023,
    cutoff: 0.49,
  },
  'sinc-s-mp': {
    taps: 255,
    cutoff: 0.46,
  },
  'sinc-m-mp': {
    taps: 511,
    cutoff: 0.475,
  },
  'sinc-m-lp': {
    taps: 511,
    cutoff: 0.476,
  },
  'sinc-l-lp': {
    taps: 1535,
    cutoff: 0.49,
  },
  'sinc-l-mp': {
    taps: 1535,
    cutoff: 0.489,
  },
  'sinc-l-ip': {
    taps: 1535,
    cutoff: 0.49,
  },
  'sinc-m-lp-ext': {
    taps: 767,
    cutoff: 0.488,
  },
  'sinc-m-lp-ext2': {
    taps: 1023,
    cutoff: 0.49,
  },
  'sinc-xl-lp': {
    taps: 2047,
    cutoff: 0.492,
  },
  'sinc-xl-mp': {
    taps: 2047,
    cutoff: 0.491,
  },
  'sinc-m-gauss': {
    taps: 767,
    cutoff: 0.485,
  },
  'sinc-l-gauss': {
    taps: 1535,
    cutoff: 0.49,
  },
  'sinc-xl-gauss': {
    taps: 2047,
    cutoff: 0.492,
  },
  'sinc-xl-gauss-apod': {
    taps: 2047,
    cutoff: 0.492,
  },
  'sinc-hires-lp': {
    taps: 1535,
    cutoff: 0.49,
  },
  'sinc-hires-mp': {
    taps: 1535,
    cutoff: 0.489,
  },
  'sinc-hb': {
    taps: 1023,
    cutoff: 0.49,
  },
  'sinc-hb-l': {
    taps: 1535,
    cutoff: 0.492,
  },
  'sinc-mega': {
    taps: 3071,
    cutoff: 0.495,
  },
  'sinc-ultra': {
    taps: 4095,
    cutoff: 0.496,
  },
  iir: {
    taps: 127,
    cutoff: 0.45,
  },
  'poly-1': {
    taps: 63,
    cutoff: 0.42,
  },
  'poly-2': {
    taps: 95,
    cutoff: 0.44,
  },
  'poly-sinc-short-mp': {
    taps: 255,
    cutoff: 0.46,
  },
  'poly-sinc-mp': {
    taps: 511,
    cutoff: 0.475,
  },
  'poly-sinc-lp': {
    taps: 511,
    cutoff: 0.476,
  },
  'poly-sinc-long-lp': {
    taps: 1535,
    cutoff: 0.49,
  },
  'poly-sinc-long-ip': {
    taps: 1535,
    cutoff: 0.49,
  },
  'poly-sinc-gauss': {
    taps: 767,
    cutoff: 0.485,
  },
  'poly-sinc-ext2': {
    taps: 1023,
    cutoff: 0.49,
  },
}

function sinc(x: number): number {
  if (x === 0) return 1
  const piX = Math.PI * x
  return Math.sin(piX) / piX
}

function createWindowedSincKernel(taps: number, cutoff: number): Float32Array {
  const kernel = new Float32Array(taps)
  const center = (taps - 1) / 2
  const normalizedCutoff = Math.min(0.499, Math.max(0.01, cutoff))

  let sum = 0

  for (let i = 0; i < taps; i += 1) {
    const offset = i - center
    const blackmanWindow =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) +
      0.08 * Math.cos((4 * Math.PI * i) / (taps - 1))
    const sample = 2 * normalizedCutoff * sinc(2 * normalizedCutoff * offset)
    const value = sample * blackmanWindow

    kernel[i] = value
    sum += value
  }

  if (sum !== 0) {
    for (let i = 0; i < taps; i += 1) {
      kernel[i] /= sum
    }
  }

  return kernel
}

function createStereoImpulseBuffer(
  context: IAudioContext,
  kernel: Float32Array,
): AudioBuffer {
  const impulseBuffer = context.createBuffer(2, kernel.length, context.sampleRate)
  impulseBuffer.copyToChannel(kernel, 0)
  impulseBuffer.copyToChannel(kernel, 1)

  return impulseBuffer
}

export function createOversamplingDspEffectDefinition(
  resolvedConfig: ResolvedOversamplingConfig | null,
): GraphDspEffectDefinition | null {
  if (!resolvedConfig) return null

  const filterId = resolvedConfig.filter.id
  const kernelSpec = FILTER_KERNEL_SPECS[filterId]
  if (!kernelSpec) return null

  const key = `${resolvedConfig.preset.id}:${resolvedConfig.targetRatePolicy}:${resolvedConfig.selectedEngine}:${resolvedConfig.outputApi}`

  return {
    key,
    create: (context) => {
      const convolverNode = context.createConvolver()
      convolverNode.normalize = false
      convolverNode.buffer = createStereoImpulseBuffer(
        context,
        createWindowedSincKernel(kernelSpec.taps, kernelSpec.cutoff),
      )

      return {
        input: convolverNode,
        output: convolverNode,
      }
    },
  }
}
