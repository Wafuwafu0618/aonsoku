import { useTranslation } from 'react-i18next'
import { CROSSFEED_PRESETS, CrossfeedPreset } from '@/crossfeed'
import {
  useCrossfeedActions,
  useCrossfeedState,
} from '@/store/player.store'
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/app/components/ui/select'
import { Switch } from '@/app/components/ui/switch'

export function CrossfeedSettings() {
  const { t } = useTranslation()
  const { enabled, preset } = useCrossfeedState()
  const { setCrossfeedEnabled, setCrossfeedPreset } = useCrossfeedActions()

  return (
    <Root>
      <Header>
        <HeaderTitle>{t('settings.audio.crossfeed.group')}</HeaderTitle>
        <HeaderDescription>
          {t('settings.audio.crossfeed.description')}
        </HeaderDescription>
      </Header>

      <Content>
        <ContentItem>
          <ContentItemTitle>
            {t('settings.audio.crossfeed.enabled')}
          </ContentItemTitle>
          <ContentItemForm>
            <Switch checked={enabled} onCheckedChange={setCrossfeedEnabled} />
          </ContentItemForm>
        </ContentItem>

        {enabled && (
          <ContentItem>
            <ContentItemTitle>
              {t('settings.audio.crossfeed.preset.label')}
            </ContentItemTitle>
            <ContentItemForm>
              <Select
                value={preset}
                onValueChange={(value) => setCrossfeedPreset(value as CrossfeedPreset)}
              >
                <SelectTrigger className="h-8 ring-offset-transparent focus:ring-0 focus:ring-transparent text-left">
                  <SelectValue>
                    <span className="text-sm text-foreground">
                      {t(`settings.audio.crossfeed.preset.options.${preset}`)}
                    </span>
                  </SelectValue>
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectGroup>
                    {CROSSFEED_PRESETS.map((option) => (
                      <SelectItem key={option} value={option}>
                        <span>
                          {t(`settings.audio.crossfeed.preset.options.${option}`)}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </ContentItemForm>
          </ContentItem>
        )}
      </Content>

      <ContentSeparator />
    </Root>
  )
}
