import clsx from 'clsx'
import { useEffect } from 'react'
import { Location, Outlet, useLocation } from 'react-router-dom'
import { ScrollArea } from '@/app/components/ui/scroll-area'
import {
  useLyricsSidebarState,
  usePlayerMediaType,
  usePlayerSonglist,
} from '@/store/player.store'
import { scrollPageToTop } from '@/utils/scrollPageToTop'

export function MainRoutes() {
  const { pathname } = useLocation() as Location
  const { lyricsSidebarState } = useLyricsSidebarState()
  const { isSong } = usePlayerMediaType()
  const { currentList, currentSongIndex } = usePlayerSonglist()
  const hasSong = Boolean(currentList[currentSongIndex])
  const shouldReserveLyricsSpace = lyricsSidebarState && isSong && hasSong

  useEffect(() => {
    if (pathname) scrollPageToTop()
  }, [pathname])

  return (
    <main
      className={clsx(
        'flex h-full transition-[padding-right] duration-300',
        shouldReserveLyricsSpace && 'md:pr-[28rem]',
      )}
    >
      <ScrollArea
        id="main-scroll-area"
        className="w-full bg-background-foreground"
      >
        <div key={pathname} className="route-transition-enter h-full w-full">
          <Outlet />
        </div>
      </ScrollArea>
    </main>
  )
}
