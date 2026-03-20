import ja from './locales/ja.json'

export const resources = {
  ja: { translation: ja },
}

export const languages = [
  {
    nativeName: '日本語',
    langCode: 'ja',
    flag: 'JP',
    dayjsLocale: 'ja',
  },
] as const

export type SupportedLanguage = (typeof languages)[number]['langCode']
