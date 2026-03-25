import { useTranslation } from 'react-i18next'
import {
  MainSidebarGroup,
  MainSidebarGroupLabel,
  MainSidebarMenu,
  MainSidebarMenuItem,
} from '@/app/components/ui/main-sidebar'
import { appleMusicLibraryItems, libraryItems } from '@/app/layout/sidebar'
import { useMediaLibraryMode } from '@/store/app.store'
import { SidebarMainItem } from './main-item'

export function NavLibrary() {
  const { t } = useTranslation()
  const { mode } = useMediaLibraryMode()

  const items = mode === 'applemusic' ? appleMusicLibraryItems : libraryItems

  return (
    <MainSidebarGroup className="px-4 py-0">
      <MainSidebarGroupLabel>{t('sidebar.library')}</MainSidebarGroupLabel>
      <MainSidebarMenu>
        {items.map((item) => (
          <MainSidebarMenuItem key={item.id}>
            <SidebarMainItem item={item} />
          </MainSidebarMenuItem>
        ))}
      </MainSidebarMenu>
    </MainSidebarGroup>
  )
}
