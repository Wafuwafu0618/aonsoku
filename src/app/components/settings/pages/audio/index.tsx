import { LyricsSettings } from './lyrics'
import { OversamplingSettings } from './oversampling'
import { ReplayGainConfig } from './replay-gain'

export function Audio() {
  return (
    <div className="space-y-4">
      <OversamplingSettings />
      <ReplayGainConfig />
      <LyricsSettings />
    </div>
  )
}
