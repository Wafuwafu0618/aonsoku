import { createRuntimeOversamplingCapability } from './capability'

describe('Oversampling runtime capability', () => {
  it('builds capability from native output APIs', () => {
    const capability = createRuntimeOversamplingCapability({
      supportedOutputApis: ['wasapi-exclusive', 'wasapi-shared'],
      availableEngines: ['cpu'],
    })

    expect(capability.supportedOutputApis).to.deep.equal(['wasapi-exclusive'])
    expect(capability.availableEngines).to.deep.equal(['cpu'])
    expect(capability.maxTapCountByEngine).to.deep.equal({ cpu: 65536 })
  })

  it('keeps tap limits for all available engines', () => {
    const capability = createRuntimeOversamplingCapability({
      supportedOutputApis: ['wasapi-shared'],
      availableEngines: ['gpu', 'cpu'],
    })

    expect(capability.supportedOutputApis).to.deep.equal([])
    expect(capability.availableEngines).to.deep.equal(['cpu', 'gpu'])
    expect(capability.maxTapCountByEngine).to.deep.equal({
      cpu: 65536,
      gpu: 262144,
    })
  })

  it('returns no output API when no exclusive/direct mode is available', () => {
    const capability = createRuntimeOversamplingCapability({
      supportedOutputApis: [],
      availableEngines: ['cpu'],
    })

    expect(capability.supportedOutputApis).to.deep.equal([])
    expect(capability.availableEngines).to.deep.equal(['cpu'])
    expect(capability.maxTapCountByEngine).to.deep.equal({ cpu: 65536 })
  })
})
