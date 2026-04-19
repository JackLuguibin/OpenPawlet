import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';

import en from './locales/en.json';
import zh from './locales/zh.json';

export const SUPPORTED_LOCALES = ['zh', 'en'] as const;
export type AppLocale = (typeof SUPPORTED_LOCALES)[number];

function syncDocumentLang(lng: string) {
  document.documentElement.lang = lng.startsWith('zh') ? 'zh-CN' : 'en';
}

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      zh: { translation: zh },
    },
    fallbackLng: 'zh',
    supportedLngs: ['en', 'zh'],
    load: 'languageOnly',
    nonExplicitSupportedLngs: true,
    interpolation: { escapeValue: false },
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
      lookupLocalStorage: 'nanobot-locale',
    },
  });

syncDocumentLang(i18n.language);
i18n.on('languageChanged', syncDocumentLang);

export default i18n;
