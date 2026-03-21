import {
  createDefaultOversamplingCapability,
  createDefaultOversamplingSettings,
} from './defaults'
import { resolveOversamplingConfig } from './resolver'

describe('Oversampling defaults (WP4 regression)', () => {
  it('uses exclusive output API and cpu engine only', () => {
    const capability = createDefaultOversamplingCapability()

    expect(capability.supportedOutputApis).to.deep.equal(['wasapi-exclusive'])
    expect(capability.availableEngines).to.deep.equal(['cpu'])
    expect(capability.maxTapCountByEngine).to.deep.equal({ cpu: 2_097_152 })
  })

  it('resolves default settings with exclusive/cpu capability', () => {
    const settings = createDefaultOversamplingSettings()
    const capability = createDefaultOversamplingCapability()

    expect(settings.targetRatePolicy).to.equal('integer-family-max')

    const result = resolveOversamplingConfig(settings, capability)

    expect(result.ok).to.equal(true)
    if (!result.ok) return

    expect(result.value.outputApi).to.equal('wasapi-exclusive')
    expect(result.value.selectedEngine).to.equal('cpu')
    expect(result.value.targetRatePolicy).to.equal('integer-family-max')
    expect(result.value.preset.id).to.equal('sinc-m-mp')
  })

  it('rejects shared mode at resolver level for default capability', () => {
    const settings = {
      ...createDefaultOversamplingSettings(),
      outputApi: 'wasapi-shared' as const,
    }
    const capability = createDefaultOversamplingCapability()

    const result = resolveOversamplingConfig(settings, capability)

    expect(result.ok).to.equal(false)
    if (result.ok) return

    expect(result.error.code).to.equal('output-api-not-supported')
  })
})
