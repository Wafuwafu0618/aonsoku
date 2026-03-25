import { Apple, Music } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { SimpleTooltip } from '@/app/components/ui/simple-tooltip'
import { Switch } from '@/app/components/ui/switch'
import { ROUTES } from '@/routes/routesList'
import { useMediaLibraryMode } from '@/store/app.store'

export function ModeToggle() {
  const { mode, setMode } = useMediaLibraryMode()
  const location = useLocation()
  const navigate = useNavigate()
  const isAppleMusic = mode === 'applemusic'

  const handleToggle = (checked: boolean) => {
    const nextMode = checked ? 'applemusic' : 'navidrome'
    setMode(nextMode)

    const isAppleMusicExclusiveRoute =
      location.pathname === ROUTES.LIBRARY.APPLE_MUSIC ||
      location.pathname.startsWith('/apple-music/')

    if (nextMode === 'navidrome' && isAppleMusicExclusiveRoute) {
      navigate(ROUTES.LIBRARY.HOME)
      return
    }

    if (
      nextMode === 'applemusic' &&
      location.pathname === ROUTES.LIBRARY.FAVORITES
    ) {
      navigate(ROUTES.LIBRARY.APPLE_MUSIC)
    }
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
