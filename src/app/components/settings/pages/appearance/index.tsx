import { BackgroundImageSettings } from './background-image'
import { ColorSettings } from './colors'
import { FullscreenSettings } from './fullscreen'
import { ThemeSettingsPicker } from './theme'

export function Appearance() {
  return (
    <div className="space-y-4">
      <BackgroundImageSettings />
      <FullscreenSettings />
      <ColorSettings />
      <ThemeSettingsPicker />
    </div>
  )
}
