import { getOversamplingFilterById } from './registry'
import { resolveOversamplingConfig } from './resolver'
import { createDefaultOversamplingSettings } from './defaults'
import { OversamplingCapability } from './types'

describe('Oversampling presets (M6)', () => {
  it('exposes phase metadata for canonical naming presets', () => {
    expect(getOversamplingFilterById('sinc-m-lp')?.phase).to.equal('linear')
    expect(getOversamplingFilterById('sinc-l-lp')?.phase).to.equal('linear')
    expect(getOversamplingFilterById('sinc-l-ip')?.phase).to.equal(
      'intermediate',
    )
    expect(getOversamplingFilterById('sinc-m-gauss')?.phase).to.equal('linear')
    expect(getOversamplingFilterById('sinc-xl-mp')?.phase).to.equal('minimum')
  })

  it('resolves canonical presets when capability allows', () => {
    const capability: OversamplingCapability = {
      supportedOutputApis: ['wasapi-exclusive'],
      availableEngines: ['cpu'],
      maxTapCountByEngine: {
        cpu: 2_097_152,
      },
    }

    const presets = [
      'sinc-m-lp',
      'sinc-l-lp',
      'sinc-l-ip',
      'sinc-m-gauss',
      'sinc-ultra',
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

  it('keeps legacy preset IDs resolvable for persisted settings', () => {
    const capability: OversamplingCapability = {
      supportedOutputApis: ['wasapi-exclusive'],
      availableEngines: ['cpu'],
      maxTapCountByEngine: {
        cpu: 2_097_152,
      },
    }

    const presets = ['poly-sinc-mp', 'poly-sinc-lp', 'poly-sinc-long-lp'] as const

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

      expect(result.ok, `legacy preset ${presetId} should resolve`).to.equal(true)
      if (!result.ok) continue
      expect(result.value.preset.id).to.equal(presetId)
      expect(result.value.filter.id).to.equal(presetId)
    }
  })
})
