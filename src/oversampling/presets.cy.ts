import { getOversamplingFilterById } from './registry'
import { resolveOversamplingConfig } from './resolver'
import { createDefaultOversamplingSettings } from './defaults'
import { OversamplingCapability } from './types'

describe('Oversampling presets (M6)', () => {
  it('exposes phase metadata for newly added presets', () => {
    expect(getOversamplingFilterById('poly-sinc-lp')?.phase).to.equal('linear')
    expect(getOversamplingFilterById('poly-sinc-long-lp')?.phase).to.equal(
      'linear',
    )
    expect(getOversamplingFilterById('poly-sinc-long-ip')?.phase).to.equal(
      'intermediate',
    )
    expect(getOversamplingFilterById('poly-sinc-gauss')?.phase).to.equal('linear')
  })

  it('resolves newly added presets when capability allows', () => {
    const capability: OversamplingCapability = {
      supportedOutputApis: ['wasapi-exclusive'],
      availableEngines: ['cpu'],
      maxTapCountByEngine: {
        cpu: 131072,
      },
    }

    const presets = [
      'poly-sinc-lp',
      'poly-sinc-long-lp',
      'poly-sinc-long-ip',
      'poly-sinc-gauss',
    ] as const

    for (const presetId of presets) {
      const result = resolveOversamplingConfig(
        {
          ...createDefaultOversamplingSettings(),
          presetId,
          targetRatePolicy: 'fixed-96000',
          outputApi: 'wasapi-exclusive',
        },
        capability,
      )

      expect(result.ok, `preset ${presetId} should resolve`).to.equal(true)
      if (!result.ok) continue
      expect(result.value.preset.id).to.equal(presetId)
      expect(result.value.filter.id).to.equal(presetId)
      expect(result.value.targetRatePolicy).to.equal('fixed-96000')
    }
  })
})
