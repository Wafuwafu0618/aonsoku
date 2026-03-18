import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { isDev } from '@/utils/env'
import { resources } from './languages'

i18n.use(initReactI18next).init({
  debug: isDev,
  lng: 'ja',
  fallbackLng: 'ja',
  supportedLngs: ['ja'],
  interpolation: {
    escapeValue: false,
  },
  resources,
})

export default i18n
