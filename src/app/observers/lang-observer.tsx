import { useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { languages } from '@/i18n/languages'
import { useLang } from '@/store/lang.store'

export function LangObserver() {
  const { i18n } = useTranslation()
  const { langCode, setLang } = useLang()
  const defaultLang = languages[0].langCode

  const setLangOnHtml = useCallback((lang: string) => {
    const root = window.document.documentElement
    root.removeAttribute('lang')
    root.setAttribute('lang', lang)
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: initial only useEffect
  useEffect(() => {
    const lang = i18n.resolvedLanguage
    if (lang && lang !== '') {
      setLang(lang)
    }
  }, [])

  useEffect(() => {
    const nextLang = languages.some((lang) => lang.langCode === langCode)
      ? langCode
      : defaultLang

    if (nextLang) {
      if (nextLang !== langCode) setLang(nextLang)
      i18n.changeLanguage(nextLang)
      setLangOnHtml(nextLang)
    }
  }, [defaultLang, i18n, langCode, setLang, setLangOnHtml])

  return null
}
