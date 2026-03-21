import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import {
  MainSidebarMenuSubButton,
  MainSidebarMenuSubItem,
} from '@/app/components/ui/main-sidebar'
import { useRouteIsActive } from '@/app/hooks/use-route-is-active'
import { ISidebarItem } from '@/app/layout/sidebar'

export function SidebarMainSubItem({ item }: { item: ISidebarItem }) {
  const { t } = useTranslation()
  const { isActive } = useRouteIsActive()
  const active = isActive(item.route)

  return (
    <MainSidebarMenuSubItem>
      <MainSidebarMenuSubButton asChild isActive={active}>
        <Link
          to={item.route}
          className={clsx(active && 'pointer-events-none')}
        >
          {t(item.title)}
        </Link>
      </MainSidebarMenuSubButton>
    </MainSidebarMenuSubItem>
  )
}
