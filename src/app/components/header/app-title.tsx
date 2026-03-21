import { AppIcon } from '@/app/components/app-icon'
import { appName } from '@/utils/appName'

export function AppTitle() {
  return (
    <div className="flex gap-2 items-center">
      <AppIcon size={24} />
      <span className="leading-7 text-sm font-medium text-muted-foreground">
        {appName}
      </span>
    </div>
  )
}
