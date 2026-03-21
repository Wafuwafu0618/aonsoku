import { useTranslation } from 'react-i18next'
import {
  OVERSAMPLING_ENGINE_PREFERENCES,
  OVERSAMPLING_LEGACY_PRESET_IDS,
  OVERSAMPLING_PROCESSING_OUTPUT_APIS,
  OVERSAMPLING_PRESET_IDS,
  OVERSAMPLING_TARGET_RATE_POLICIES,
  OversamplingEnginePreference,
  OversamplingOutputApi,
  OversamplingPresetId,
  OversamplingTargetRatePolicy,
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

const oversamplingPresets: OversamplingPresetId[] = [
  ...OVERSAMPLING_PRESET_IDS,
  ...OVERSAMPLING_LEGACY_PRESET_IDS,
]
const oversamplingEnginePreferences: OversamplingEnginePreference[] = [
  ...OVERSAMPLING_ENGINE_PREFERENCES,
]
const oversamplingOutputApis: OversamplingOutputApi[] = [
  ...OVERSAMPLING_PROCESSING_OUTPUT_APIS,
]
const oversamplingTargetRatePolicies: OversamplingTargetRatePolicy[] = [
  ...OVERSAMPLING_TARGET_RATE_POLICIES,
]
const targetRatePolicyLabel: Record<OversamplingTargetRatePolicy, string> = {
  'integer-family-max': 'Auto (family max)',
  'fixed-88200': '88.2 kHz',
  'fixed-96000': '96 kHz',
  'fixed-176400': '176.4 kHz',
  'fixed-192000': '192 kHz',
  'fixed-352800': '352.8 kHz',
  'fixed-384000': '384 kHz',
  'fixed-705600': '705.6 kHz',
  'fixed-768000': '768 kHz',
  'fixed-1411200': '1411.2 kHz',
  'fixed-1536000': '1536 kHz',
}

export function OversamplingSettings() {
  const { t } = useTranslation()
  const {
    enabled,
    presetId,
    targetRatePolicy,
    enginePreference,
    outputApi,
    capability,
  } =
    useOversamplingState()
  const {
    setEnabled,
    setPresetId,
    setTargetRatePolicy,
    setEnginePreference,
    setOutputApi,
  } =
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

  const isEngineOptionSupported = (engine: OversamplingEnginePreference) => {
    if (engine === 'auto') return true

    return capability.availableEngines.includes(engine)
  }

  const isOutputApiSupported = (api: OversamplingOutputApi) =>
    capability.supportedOutputApis.includes(api)

  const getPresetLabel = (id: OversamplingPresetId): string => {
    const key = `settings.audio.oversampling.preset.options.${id}`
    const label = t(key)
    return label === key ? id : label
  }

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
                      {getPresetLabel(presetId)}
                    </span>
                  </SelectValue>
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectGroup>
                    {oversamplingPresets.map((preset) => (
                      <SelectItem key={preset} value={preset}>
                        <span>{getPresetLabel(preset)}</span>
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
            <ContentItemTitle>出力サンプルレート</ContentItemTitle>
            <ContentItemForm>
              <Select
                value={targetRatePolicy}
                onValueChange={(value) =>
                  setTargetRatePolicy(value as OversamplingTargetRatePolicy)
                }
              >
                <SelectTrigger className="h-8 ring-offset-transparent focus:ring-0 focus:ring-transparent text-left">
                  <SelectValue>
                    <span className="text-sm text-foreground">
                      {targetRatePolicyLabel[targetRatePolicy]}
                    </span>
                  </SelectValue>
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectGroup>
                    {oversamplingTargetRatePolicies.map((policy) => (
                      <SelectItem key={policy} value={policy}>
                        <span>{targetRatePolicyLabel[policy]}</span>
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
                      <SelectItem
                        key={engine}
                        value={engine}
                        disabled={!isEngineOptionSupported(engine)}
                      >
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
                      <SelectItem
                        key={api}
                        value={api}
                        disabled={!isOutputApiSupported(api)}
                      >
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
