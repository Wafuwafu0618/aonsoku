import { LyricsSettings } from './lyrics'
import { OversamplingSettings } from './oversampling'
import { ParametricEqSettings } from './parametric-eq'
import { ReplayGainConfig } from './replay-gain'

export function Audio() {
  return (
    <div className="space-y-4">
      <OversamplingSettings />
      <ParametricEqSettings />
      <ReplayGainConfig />
      <LyricsSettings />
    </div>
  )
}
