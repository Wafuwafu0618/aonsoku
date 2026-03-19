import {
  createDefaultOversamplingCapability,
  createDefaultOversamplingSettings,
} from './defaults'
import { resolveOversamplingConfig } from './resolver'

describe('Oversampling defaults (WP4 regression)', () => {
  it('uses shared output API and cpu engine only', () => {
    const capability = createDefaultOversamplingCapability()

    expect(capability.supportedOutputApis).to.deep.equal(['wasapi-shared'])
    expect(capability.availableEngines).to.deep.equal(['cpu'])
    expect(capability.maxTapCountByEngine).to.deep.equal({ cpu: 65536 })
  })

  it('resolves default settings with shared/cpu capability', () => {
    const settings = createDefaultOversamplingSettings()
    const capability = createDefaultOversamplingCapability()

    const result = resolveOversamplingConfig(settings, capability)

    expect(result.ok).to.equal(true)
    if (!result.ok) return

    expect(result.value.outputApi).to.equal('wasapi-shared')
    expect(result.value.selectedEngine).to.equal('cpu')
    expect(result.value.preset.id).to.equal('poly-sinc-mp')
  })

  it('rejects exclusive mode at resolver level for default capability', () => {
    const settings = {
      ...createDefaultOversamplingSettings(),
      outputApi: 'wasapi-exclusive' as const,
    }
    const capability = createDefaultOversamplingCapability()

    const result = resolveOversamplingConfig(settings, capability)

    expect(result.ok).to.equal(false)
    if (result.ok) return

    expect(result.error.code).to.equal('output-api-not-supported')
  })
})
