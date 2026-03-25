import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { MainSidebarMenuButton } from '@/app/components/ui/main-sidebar'
import { useRouteIsActive } from '@/app/hooks/use-route-is-active'
import { ISidebarItem } from '@/app/layout/sidebar'

export function SidebarMainItem({ item }: { item: ISidebarItem }) {
  const { t } = useTranslation()
  const { isActive } = useRouteIsActive()
  const active = isActive(item.route)

  return (
    <MainSidebarMenuButton
      asChild
      tooltip={t(item.title)}
      isActive={active}
    >
      <Link
        to={item.route}
      >
        <item.icon />
        {t(item.title)}
      </Link>
    </MainSidebarMenuButton>
  )
}
