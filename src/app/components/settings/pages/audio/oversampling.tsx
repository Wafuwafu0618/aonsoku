import { useTranslation } from 'react-i18next'
import {
  OVERSAMPLING_ENGINE_PREFERENCES,
  OVERSAMPLING_OUTPUT_APIS,
  OVERSAMPLING_PRESET_IDS,
  OversamplingEnginePreference,
  OversamplingOutputApi,
  OversamplingPresetId,
} from '@/oversampling'
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
} from '@/app/components/settings/section'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/app/components/ui/select'
import { Switch } from '@/app/components/ui/switch'
import {
  useOversamplingActions,
  useOversamplingState,
} from '@/store/player.store'

const oversamplingPresets: OversamplingPresetId[] = [...OVERSAMPLING_PRESET_IDS]
const oversamplingEnginePreferences: OversamplingEnginePreference[] = [
  ...OVERSAMPLING_ENGINE_PREFERENCES,
]
const oversamplingOutputApis: OversamplingOutputApi[] = [
  ...OVERSAMPLING_OUTPUT_APIS,
]

export function OversamplingSettings() {
  const { t } = useTranslation()
  const { enabled, presetId, enginePreference, outputApi, capability } =
    useOversamplingState()
  const { setEnabled, setPresetId, setEnginePreference, setOutputApi } =
    useOversamplingActions()

  const availableEnginesLabel =
    capability.availableEngines.length > 0
      ? capability.availableEngines
          .map((engine) => t(`settings.audio.oversampling.engine.options.${engine}`))
          .join(', ')
      : t('settings.audio.oversampling.capability.none')

  const supportedOutputApisLabel =
    capability.supportedOutputApis.length > 0
      ? capability.supportedOutputApis
          .map((api) => t(`settings.audio.oversampling.outputApi.options.${api}`))
          .join(', ')
      : t('settings.audio.oversampling.capability.none')

  return (
    <Root>
      <Header>
        <HeaderTitle>{t('settings.audio.oversampling.group')}</HeaderTitle>
        <HeaderDescription>
          {t('settings.audio.oversampling.description')}
        </HeaderDescription>
      </Header>

      <Content>
        <ContentItem>
          <ContentItemTitle>
            {t('settings.audio.oversampling.enabled')}
          </ContentItemTitle>
          <ContentItemForm>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </ContentItemForm>
        </ContentItem>

        {enabled && (
          <ContentItem>
            <ContentItemTitle>
              {t('settings.audio.oversampling.preset.label')}
            </ContentItemTitle>
            <ContentItemForm>
              <Select
                value={presetId}
                onValueChange={(value) => setPresetId(value as OversamplingPresetId)}
              >
                <SelectTrigger className="h-8 ring-offset-transparent focus:ring-0 focus:ring-transparent text-left">
                  <SelectValue>
                    <span className="text-sm text-foreground">
                      {t(`settings.audio.oversampling.preset.options.${presetId}`)}
                    </span>
                  </SelectValue>
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectGroup>
                    {oversamplingPresets.map((preset) => (
                      <SelectItem key={preset} value={preset}>
                        <span>
                          {t(`settings.audio.oversampling.preset.options.${preset}`)}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </ContentItemForm>
          </ContentItem>
        )}

        {enabled && (
          <ContentItem>
            <ContentItemTitle>
              {t('settings.audio.oversampling.engine.label')}
            </ContentItemTitle>
            <ContentItemForm>
              <Select
                value={enginePreference}
                onValueChange={(value) =>
                  setEnginePreference(value as OversamplingEnginePreference)
                }
              >
                <SelectTrigger className="h-8 ring-offset-transparent focus:ring-0 focus:ring-transparent text-left">
                  <SelectValue>
                    <span className="text-sm text-foreground">
                      {t(
                        `settings.audio.oversampling.engine.options.${enginePreference}`,
                      )}
                    </span>
                  </SelectValue>
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectGroup>
                    {oversamplingEnginePreferences.map((engine) => (
                      <SelectItem key={engine} value={engine}>
                        <span>
                          {t(`settings.audio.oversampling.engine.options.${engine}`)}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </ContentItemForm>
          </ContentItem>
        )}

        {enabled && (
          <ContentItem>
            <ContentItemTitle>
              {t('settings.audio.oversampling.outputApi.label')}
            </ContentItemTitle>
            <ContentItemForm>
              <Select
                value={outputApi}
                onValueChange={(value) => setOutputApi(value as OversamplingOutputApi)}
              >
                <SelectTrigger className="h-8 ring-offset-transparent focus:ring-0 focus:ring-transparent text-left">
                  <SelectValue>
                    <span className="text-sm text-foreground">
                      {t(`settings.audio.oversampling.outputApi.options.${outputApi}`)}
                    </span>
                  </SelectValue>
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectGroup>
                    {oversamplingOutputApis.map((api) => (
                      <SelectItem key={api} value={api}>
                        <span>
                          {t(`settings.audio.oversampling.outputApi.options.${api}`)}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </ContentItemForm>
          </ContentItem>
        )}

        <ContentItem>
          <ContentItemTitle
            info={t('settings.audio.oversampling.capability.engines.info')}
          >
            {t('settings.audio.oversampling.capability.engines.label')}
          </ContentItemTitle>
          <ContentItemForm className="text-right text-xs text-muted-foreground">
            <span>{availableEnginesLabel}</span>
          </ContentItemForm>
        </ContentItem>

        <ContentItem>
          <ContentItemTitle
            info={t('settings.audio.oversampling.capability.outputApis.info')}
          >
            {t('settings.audio.oversampling.capability.outputApis.label')}
          </ContentItemTitle>
          <ContentItemForm className="text-right text-xs text-muted-foreground">
            <span>{supportedOutputApisLabel}</span>
          </ContentItemForm>
        </ContentItem>
      </Content>

      <ContentSeparator />
    </Root>
  )
}
