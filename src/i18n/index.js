// vue-i18n setup. Locales live in src/locales/{en,es,fr,de}.json
// and are imported eagerly so the locale switcher is instant —
// the entire dictionary is small enough that lazy-loading per
// locale adds latency without saving meaningful bytes.
//
// The English dictionary is the source of truth. Translations
// are generated AI-assisted via scripts/translate-locales.js
// (Claude API) and proofread by federation admins in-app.
//
// Locale persistence:
//   1. localStorage('locale')  — primary, survives sign-out
//   2. navigator.language      — first-visit fallback, e.g. a
//                                French-speaking spectator hits
//                                the site on a phone set to fr-FR
//                                and gets French automatically
//   3. 'en'                    — final fallback
//
// Server-side user.locale (per-user preference) comes later as
// part of the i18next middleware roll-out; for now this is a
// browser-only state.

import { createI18n } from 'vue-i18n'
import en from '@/locales/en.json'
import es from '@/locales/es.json'
import fr from '@/locales/fr.json'
import de from '@/locales/de.json'

export const SUPPORTED_LOCALES = [
  { code: 'en', label: 'English',  flag: '🇬🇧' },
  { code: 'es', label: 'Español',  flag: '🇪🇸' },
  { code: 'fr', label: 'Français', flag: '🇫🇷' },
  { code: 'de', label: 'Deutsch',  flag: '🇩🇪' },
]

export const FALLBACK_LOCALE = 'en'

function detectInitialLocale() {
  try {
    const stored = localStorage.getItem('locale')
    if (stored && SUPPORTED_LOCALES.some(l => l.code === stored)) return stored
  } catch { /* localStorage blocked in some private contexts */ }

  // navigator.language is e.g. "fr-FR" — match on the 2-letter prefix.
  const nav = (typeof navigator !== 'undefined' ? navigator.language : '') || ''
  const prefix = nav.split('-')[0].toLowerCase()
  if (SUPPORTED_LOCALES.some(l => l.code === prefix)) return prefix

  return FALLBACK_LOCALE
}

const i18n = createI18n({
  legacy: false,            // composition-API mode — useI18n() returns reactive
  globalInjection: true,    // $t available without explicit useI18n()
  locale: detectInitialLocale(),
  fallbackLocale: FALLBACK_LOCALE,
  // Silent in development: vue-i18n warns on every missing key,
  // which is noisy while we're rolling out the extraction sweep
  // page-by-page. Re-enable once the dictionary is complete.
  missingWarn: false,
  fallbackWarn: false,
  messages: { en, es, fr, de },
})

// Public setter — every locale change goes through this so the
// localStorage write + <html lang> sync stay in lockstep.
export function setLocale(code) {
  if (!SUPPORTED_LOCALES.some(l => l.code === code)) return
  i18n.global.locale.value = code
  try { localStorage.setItem('locale', code) } catch { /* ignore */ }
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('lang', code)
  }
}

// Initialize <html lang> on boot.
if (typeof document !== 'undefined') {
  document.documentElement.setAttribute('lang', i18n.global.locale.value)
}

export default i18n
