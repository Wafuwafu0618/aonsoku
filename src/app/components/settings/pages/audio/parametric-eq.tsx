import { FileAudio, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'react-toastify'
import { parseParametricEqText } from '@/parametric-eq'
import { pickParametricEqFile, readLocalLibraryFile } from '@/platform'
import { isDesktop } from '@/platform/capabilities'
import {
  useParametricEqActions,
  useParametricEqState,
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
import { Button } from '@/app/components/ui/button'
import { Switch } from '@/app/components/ui/switch'

function formatDb(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)} dB`
}

export function ParametricEqSettings() {
  const { t } = useTranslation()
  const { enabled, profile } = useParametricEqState()
  const { setParametricEqEnabled, setParametricEqProfile } = useParametricEqActions()
  const [isImporting, setIsImporting] = useState(false)

  async function handleImport() {
    if (!isDesktop()) return

    setIsImporting(true)
    try {
      const selected = await pickParametricEqFile()
      if (!selected) return

      const fileContent = await readLocalLibraryFile(selected.path)
      const text = new TextDecoder('utf-8').decode(fileContent.data)
      const parsed = parseParametricEqText(text)

      setParametricEqProfile({
        name: selected.name,
        sourcePath: selected.path,
        importedAt: Date.now(),
        preampDb: parsed.preampDb,
        bands: parsed.bands,
      })
      setParametricEqEnabled(true)

      if (parsed.warnings.length > 0) {
        toast.warn(
          t('settings.audio.parametricEq.import.warning', {
            count: parsed.warnings.length,
          }),
        )
      } else {
        toast.success(t('settings.audio.parametricEq.import.success'))
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      toast.error(
        t('settings.audio.parametricEq.import.error', {
          reason: detail,
        }),
      )
    } finally {
      setIsImporting(false)
    }
  }

  function handleClearProfile() {
    setParametricEqEnabled(false)
    setParametricEqProfile(null)
  }

  const canToggle = profile !== null
  const desktop = isDesktop()

  return (
    <Root>
      <Header>
        <HeaderTitle>{t('settings.audio.parametricEq.group')}</HeaderTitle>
        <HeaderDescription>
          {t('settings.audio.parametricEq.description')}
        </HeaderDescription>
      </Header>

      <Content>
        <ContentItem>
          <ContentItemTitle>
            {t('settings.audio.parametricEq.enabled')}
          </ContentItemTitle>
          <ContentItemForm>
            <Switch
              checked={enabled}
              onCheckedChange={setParametricEqEnabled}
              disabled={!canToggle}
            />
          </ContentItemForm>
        </ContentItem>

        <ContentItem>
          <ContentItemTitle>
            {t('settings.audio.parametricEq.import.label')}
          </ContentItemTitle>
          <ContentItemForm>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleImport}
              disabled={!desktop || isImporting}
            >
              <FileAudio className="w-4 h-4 mr-2" />
              {isImporting
                ? t('settings.audio.parametricEq.import.loading')
                : t('settings.audio.parametricEq.import.button')}
            </Button>
          </ContentItemForm>
        </ContentItem>

        {profile && (
          <div className="space-y-2 rounded-md border p-3">
            <div className="text-sm font-medium text-foreground truncate" title={profile.name}>
              {profile.name}
            </div>
            <div className="text-xs text-muted-foreground truncate" title={profile.sourcePath}>
              {profile.sourcePath}
            </div>
            <div className="text-sm text-muted-foreground">
              {t('settings.audio.parametricEq.summary', {
                count: profile.bands.length,
                preamp: formatDb(profile.preampDb),
              })}
            </div>
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {profile.bands.map((band) => (
                <div key={band.index} className="text-xs text-muted-foreground">
                  {`#${band.index} ${band.type} ${band.frequencyHz.toFixed(1)} Hz / ${formatDb(
                    band.gainDb,
                  )} / Q ${band.q.toFixed(2)}`}
                </div>
              ))}
            </div>
            <Button type="button" size="sm" variant="ghost" onClick={handleClearProfile}>
              <Trash2 className="w-4 h-4 mr-2" />
              {t('settings.audio.parametricEq.clear')}
            </Button>
          </div>
        )}

        {!desktop && (
          <div className="text-xs text-muted-foreground">
            {t('settings.audio.parametricEq.desktopOnly')}
          </div>
        )}
      </Content>

      <ContentSeparator />
    </Root>
  )
}
