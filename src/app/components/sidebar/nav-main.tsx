import {
  MainSidebarGroup,
  MainSidebarMenu,
} from '@/app/components/ui/main-sidebar'
import {
  appleMusicMainNavItems,
  mainNavItems,
  SidebarItems,
} from '@/app/layout/sidebar'
import { useAppStore, useMediaLibraryMode } from '@/store/app.store'
import { SidebarMainItem } from './main-item'

export function NavMain() {
  const hideRadiosSection = useAppStore().pages.hideRadiosSection
  const { mode } = useMediaLibraryMode()

  const navItems = mode === 'applemusic' ? appleMusicMainNavItems : mainNavItems

  return (
    <MainSidebarGroup className="px-4 group-data-[collapsible=icon]:py-1">
      <MainSidebarMenu>
        {navItems.map((item) => {
          if (hideRadiosSection && item.id === SidebarItems.Radios) return null

          return <SidebarMainItem key={item.id} item={item} />
        })}
      </MainSidebarMenu>
    </MainSidebarGroup>
  )
}
