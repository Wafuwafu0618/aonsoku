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
} from '@/app/components/settings/section'
import { Input } from '@/app/components/ui/input'
import { Switch } from '@/app/components/ui/switch'
import { useAppAccounts } from '@/store/app.store'

export function DiscordRpc() {
  const { t } = useTranslation()
  const { discord } = useAppAccounts()

  return (
    <Root>
      <Header>
        <HeaderTitle>{t('settings.accounts.discord.group')}</HeaderTitle>
        <HeaderDescription>
          {t('settings.accounts.discord.description')}
        </HeaderDescription>
      </Header>
      <Content>
        <ContentItem>
          <ContentItemTitle>
            {t('settings.accounts.discord.enabled.label')}
          </ContentItemTitle>
          <ContentItemForm>
            <Switch
              checked={discord.rpcEnabled}
              onCheckedChange={discord.setRpcEnabled}
            />
          </ContentItemForm>
        </ContentItem>
        <ContentItem>
          <ContentItemTitle info={t('settings.accounts.discord.clientId.info')}>
            {t('settings.accounts.discord.clientId.label')}
          </ContentItemTitle>
          <ContentItemForm className="w-3/5 max-w-none">
            <Input
              value={discord.rpcClientId}
              onChange={(event) => discord.setRpcClientId(event.target.value)}
              placeholder={t('settings.accounts.discord.clientId.placeholder')}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </ContentItemForm>
        </ContentItem>
      </Content>
      <ContentSeparator />
    </Root>
  )
}
