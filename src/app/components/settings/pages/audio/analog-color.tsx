import { useTranslation } from 'react-i18next'
import { ANALOG_COLOR_PRESETS, AnalogColorPreset } from '@/analog-color'
import {
  useAnalogColorActions,
  useAnalogColorState,
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

export function AnalogColorSettings() {
  const { t } = useTranslation()
  const { enabled, preset } = useAnalogColorState()
  const { setAnalogColorEnabled, setAnalogColorPreset } = useAnalogColorActions()

  return (
    <Root>
      <Header>
        <HeaderTitle>{t('settings.audio.analogColor.group')}</HeaderTitle>
        <HeaderDescription>
          {t('settings.audio.analogColor.description')}
        </HeaderDescription>
      </Header>

      <Content>
        <ContentItem>
          <ContentItemTitle>
            {t('settings.audio.analogColor.enabled')}
          </ContentItemTitle>
          <ContentItemForm>
            <Switch checked={enabled} onCheckedChange={setAnalogColorEnabled} />
          </ContentItemForm>
        </ContentItem>

        {enabled && (
          <ContentItem>
            <ContentItemTitle>
              {t('settings.audio.analogColor.preset.label')}
            </ContentItemTitle>
            <ContentItemForm>
              <Select
                value={preset}
                onValueChange={(value) => setAnalogColorPreset(value as AnalogColorPreset)}
              >
                <SelectTrigger className="h-8 ring-offset-transparent focus:ring-0 focus:ring-transparent text-left">
                  <SelectValue>
                    <span className="text-sm text-foreground">
                      {t(`settings.audio.analogColor.preset.options.${preset}`)}
                    </span>
                  </SelectValue>
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectGroup>
                    {ANALOG_COLOR_PRESETS.map((option) => (
                      <SelectItem key={option} value={option}>
                        <span>
                          {t(`settings.audio.analogColor.preset.options.${option}`)}
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
