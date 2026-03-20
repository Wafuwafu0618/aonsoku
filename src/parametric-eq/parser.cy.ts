import { parseParametricEqText } from './parser'

describe('Parametric EQ parser', () => {
  it('parses AutoEq style profile', () => {
    const content = [
      'Preamp: -4.98 dB',
      'Filter 1: ON LSC Fc 105.0 Hz Gain 6.3 dB Q 0.70',
      'Filter 2: ON PK Fc 75.7 Hz Gain -3.2 dB Q 0.32',
      'Filter 3: ON PK Fc 1805.2 Hz Gain 4.1 dB Q 1.62',
      'Filter 4: OFF PK Fc 2912.9 Hz Gain -4.0 dB Q 3.59',
      'Filter 5: ON HSC Fc 10000.0 Hz Gain -1.9 dB Q 0.70',
    ].join('\n')

    const result = parseParametricEqText(content)

    expect(result.preampDb).to.equal(-4.98)
    expect(result.bands).to.have.length(4)
    expect(result.bands[0]).to.deep.include({
      index: 1,
      enabled: true,
      type: 'LSC',
      frequencyHz: 105.0,
      gainDb: 6.3,
      q: 0.7,
    })
    expect(result.bands[3]).to.deep.include({
      index: 5,
      enabled: true,
      type: 'HSC',
      frequencyHz: 10000.0,
      gainDb: -1.9,
      q: 0.7,
    })
  })

  it('throws when no enabled filter exists', () => {
    const content = [
      'Preamp: -4.98 dB',
      'Filter 1: OFF PK Fc 1000.0 Hz Gain 2.0 dB Q 1.0',
    ].join('\n')

    expect(() => parseParametricEqText(content)).to.throw(
      'No enabled filters were found in the imported file.',
    )
  })
})
