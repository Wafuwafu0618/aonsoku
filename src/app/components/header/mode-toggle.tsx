import { Apple, Music } from 'lucide-react'
import { SimpleTooltip } from '@/app/components/ui/simple-tooltip'
import { Switch } from '@/app/components/ui/switch'
import { useMediaLibraryMode } from '@/store/app.store'

export function ModeToggle() {
  const { mode, setMode } = useMediaLibraryMode()
  const isAppleMusic = mode === 'applemusic'

  const handleToggle = (checked: boolean) => {
    setMode(checked ? 'applemusic' : 'navidrome')
  }

  return (
    <SimpleTooltip
      text={isAppleMusic ? 'Apple Music Mode' : 'Navidrome Mode'}
      side="bottom"
    >
      <div className="flex items-center gap-2 h-8 px-2 rounded-md bg-muted/50">
        <Music
          className={`w-4 h-4 transition-colors ${!isAppleMusic ? 'text-primary' : 'text-muted-foreground'}`}
        />
        <Switch
          checked={isAppleMusic}
          onCheckedChange={handleToggle}
          className="data-[state=checked]:bg-[#FA2D48]"
        />
        <Apple
          className={`w-4 h-4 transition-colors ${isAppleMusic ? 'text-[#FA2D48]' : 'text-muted-foreground'}`}
        />
      </div>
    </SimpleTooltip>
  )
}
