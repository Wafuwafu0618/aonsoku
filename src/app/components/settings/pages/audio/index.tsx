import { LyricsSettings } from './lyrics'
import { OversamplingSettings } from './oversampling'
import { HeadroomSettings } from './headroom'
import { CrossfeedSettings } from './crossfeed'
import { ParametricEqSettings } from './parametric-eq'
import { ReplayGainConfig } from './replay-gain'
import { AnalogColorSettings } from './analog-color'

export function Audio() {
  return (
    <div className="space-y-4">
      <OversamplingSettings />
      <HeadroomSettings />
      <CrossfeedSettings />
      <AnalogColorSettings />
      <ParametricEqSettings />
      <ReplayGainConfig />
      <LyricsSettings />
    </div>
  )
}
