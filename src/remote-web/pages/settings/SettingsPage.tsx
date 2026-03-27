import { cn } from '@/lib/utils'

export type RemoteWavePresetId =
  | 'amethyst'
  | 'azure'
  | 'emerald'
  | 'sunset'
  | 'mono'
  | 'mock'

export interface RemoteWavePreset {
  id: RemoteWavePresetId
  name: string
  description: string
  colors: [string, string, string]
}

interface SettingsPageProps {
  presets: RemoteWavePreset[]
  selectedPreset: RemoteWavePresetId
  onSelectPreset: (presetId: RemoteWavePresetId) => void
}

export function SettingsPage({
  presets,
  selectedPreset,
  onSelectPreset,
}: SettingsPageProps) {
  return (
    <div className="p-4 space-y-6">
      <section className="space-y-2">
        <h2 className="text-lg font-semibold tracking-tight">デザイン設定</h2>
        <p className="text-sm text-muted-foreground">
          Minato Wave の背景カラーを選択できます
        </p>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-medium text-muted-foreground">背景カラー</h3>
        <div className="space-y-2.5">
          {presets.map((preset) => {
            const isActive = preset.id === selectedPreset
            return (
              <button
                key={preset.id}
                onClick={() => onSelectPreset(preset.id)}
                className={cn(
                  'w-full rounded-xl border px-3 py-3 text-left transition-all',
                  'remote-settings-preset',
                  isActive
                    ? 'remote-settings-preset-active'
                    : 'hover:border-white/30',
                )}
              >
                <div className="flex items-start gap-3">
                  <div className="remote-settings-swatches">
                    {preset.colors.map((color) => (
                      <span
                        key={`${preset.id}-${color}`}
                        className="remote-settings-swatch"
                        style={{ background: color }}
                      />
                    ))}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{preset.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {preset.description}
                    </p>
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      </section>
    </div>
  )
}
