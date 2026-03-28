import { useTranslation } from 'react-i18next'
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
import { NumericInput } from '@/app/components/ui/numeric-input'
import { useHeadroomActions, useHeadroomState } from '@/store/player.store'

export function HeadroomSettings() {
  const { t } = useTranslation()
  const { headroomDb } = useHeadroomState()
  const { setHeadroomDb } = useHeadroomActions()

  return (
    <Root>
      <Header>
        <HeaderTitle>{t('settings.audio.headroom.group')}</HeaderTitle>
        <HeaderDescription>
          {t('settings.audio.headroom.description')}
        </HeaderDescription>
      </Header>

      <Content>
        <ContentItem>
          <ContentItemTitle info={t('settings.audio.headroom.value.info')}>
            {t('settings.audio.headroom.value.label')}
          </ContentItemTitle>
          <ContentItemForm>
            <NumericInput
              value={headroomDb}
              onChange={setHeadroomDb}
              min={-18}
              max={0}
              step={0.5}
            />
          </ContentItemForm>
        </ContentItem>
      </Content>

      <ContentSeparator />
    </Root>
  )
}

