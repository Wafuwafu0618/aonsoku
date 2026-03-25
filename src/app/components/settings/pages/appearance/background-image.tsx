import { ImagePlus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'react-toastify'
import { Button } from '@/app/components/ui/button'
import { useBackgroundImageSource } from '@/app/hooks/use-background-image-source'
import { pickBackgroundImageFile } from '@/platform'
import { isDesktop } from '@/platform/capabilities'
import { useAppBackgroundImage } from '@/store/app.store'
import {
  Content,
  ContentItem,
  ContentItemForm,
  ContentItemTitle,
  ContentSeparator,
  Header,
  HeaderDescription,
  HeaderTitle,
  Root,
} from '../../section'

export function BackgroundImageSettings() {
  const { t } = useTranslation()
  const { backgroundImageUrl, backgroundImageName, setBackgroundImage } =
    useAppBackgroundImage()
  const backgroundImageSource = useBackgroundImageSource()
  const [isSelecting, setIsSelecting] = useState(false)
  const desktop = isDesktop()

  async function handleSelectImage() {
    if (!desktop) return

    setIsSelecting(true)
    try {
      const selected = await pickBackgroundImageFile()
      if (!selected) return

      setBackgroundImage({
        url: selected.path,
        name: selected.name,
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      toast.error(
        t('settings.appearance.background.select.error', { reason }),
      )
    } finally {
      setIsSelecting(false)
    }
  }

  function handleClearImage() {
    setBackgroundImage(null)
  }

  return (
    <Root>
      <Header>
        <HeaderTitle>{t('settings.appearance.background.group')}</HeaderTitle>
        <HeaderDescription>
          {t('settings.appearance.background.description')}
        </HeaderDescription>
      </Header>

      <Content>
        <ContentItem>
          <ContentItemTitle>
            {t('settings.appearance.background.select.label')}
          </ContentItemTitle>
          <ContentItemForm className="max-w-none w-auto gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleSelectImage}
              disabled={!desktop || isSelecting}
            >
              <ImagePlus className="w-4 h-4 mr-2" />
              {isSelecting
                ? t('settings.appearance.background.select.loading')
                : t('settings.appearance.background.select.button')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleClearImage}
              disabled={!backgroundImageUrl}
            >
              <Trash2 className="w-4 h-4 mr-2" />
              {t('settings.appearance.background.clear')}
            </Button>
          </ContentItemForm>
        </ContentItem>

        <div className="space-y-2 rounded-md border p-3">
          <div className="text-sm font-medium">
            {backgroundImageName || t('settings.appearance.background.none')}
          </div>
          {backgroundImageSource ? (
            <div className="h-24 w-full rounded border border-border/70 overflow-hidden">
              <img
                src={backgroundImageSource}
                alt={backgroundImageName || 'background image'}
                className="h-full w-full object-cover"
              />
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              {t('settings.appearance.background.hint')}
            </div>
          )}
          {!desktop && (
            <div className="text-xs text-muted-foreground">
              {t('settings.appearance.background.desktopOnly')}
            </div>
          )}
        </div>
      </Content>

      <ContentSeparator />
    </Root>
  )
}
