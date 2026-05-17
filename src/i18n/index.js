// vue-i18n setup. Locales live in src/locales/{...}.json and are
// imported eagerly so the locale switcher is instant — the entire
// dictionary is small enough that lazy-loading per locale adds
// latency without saving meaningful bytes.
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
// RTL support: setLocale() also sets <html dir="rtl"|"ltr"> based
// on the SUPPORTED_LOCALES entry's `rtl` flag. Tailwind / regular
// CSS already respects `dir` for things like text-alignment and
// list-bullet position, so the existing layout flips cleanly for
// Arabic without per-component changes.

import { createI18n } from 'vue-i18n'
import en from '@/locales/en.json'
import es from '@/locales/es.json'
import fr from '@/locales/fr.json'
import de from '@/locales/de.json'
import it from '@/locales/it.json'
import pt from '@/locales/pt.json'
import pl from '@/locales/pl.json'
import ru from '@/locales/ru.json'
import uk from '@/locales/uk.json'
import fi from '@/locales/fi.json'
import sv from '@/locales/sv.json'
import da from '@/locales/da.json'
import no from '@/locales/no.json'
import hu from '@/locales/hu.json'
import hr from '@/locales/hr.json'
import sr from '@/locales/sr.json'
import zh from '@/locales/zh.json'
import ja from '@/locales/ja.json'
import ko from '@/locales/ko.json'
import id from '@/locales/id.json'
import ms from '@/locales/ms.json'
import tl from '@/locales/tl.json'
import ar from '@/locales/ar.json'
import tr from '@/locales/tr.json'
import el from '@/locales/el.json'

export const SUPPORTED_LOCALES = [
  { code: 'en', label: 'English',          flag: '🇬🇧' },
  { code: 'es', label: 'Español',          flag: '🇪🇸' },
  { code: 'fr', label: 'Français',         flag: '🇫🇷' },
  { code: 'de', label: 'Deutsch',          flag: '🇩🇪' },
  { code: 'it', label: 'Italiano',         flag: '🇮🇹' },
  { code: 'pt', label: 'Português',        flag: '🇵🇹' },
  { code: 'pl', label: 'Polski',           flag: '🇵🇱' },
  { code: 'ru', label: 'Русский',          flag: '🇷🇺' },
  { code: 'uk', label: 'Українська',       flag: '🇺🇦' },
  { code: 'fi', label: 'Suomi',            flag: '🇫🇮' },
  { code: 'sv', label: 'Svenska',          flag: '🇸🇪' },
  { code: 'da', label: 'Dansk',            flag: '🇩🇰' },
  { code: 'no', label: 'Norsk',            flag: '🇳🇴' },
  { code: 'hu', label: 'Magyar',           flag: '🇭🇺' },
  { code: 'hr', label: 'Hrvatski',         flag: '🇭🇷' },
  { code: 'sr', label: 'Српски',           flag: '🇷🇸' },
  { code: 'zh', label: '中文',              flag: '🇨🇳' },
  { code: 'ja', label: '日本語',            flag: '🇯🇵' },
  { code: 'ko', label: '한국어',            flag: '🇰🇷' },
  { code: 'id', label: 'Bahasa Indonesia', flag: '🇮🇩' },
  { code: 'ms', label: 'Bahasa Melayu',    flag: '🇲🇾' },
  { code: 'tl', label: 'Tagalog',          flag: '🇵🇭' },
  { code: 'ar', label: 'العربية',          flag: '🇸🇦', rtl: true },
  { code: 'tr', label: 'Türkçe',           flag: '🇹🇷' },
  { code: 'el', label: 'Ελληνικά',         flag: '🇬🇷' },
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
  messages: {
    en, es, fr, de, it, pt, pl, ru, uk, fi, sv, da, no, hu,
    hr, sr, zh, ja, ko, id, ms, tl, ar, tr, el,
  },
})

// Public setter — every locale change goes through this so the
// localStorage write + <html lang> + <html dir> sync stay in lockstep.
export function setLocale(code) {
  const entry = SUPPORTED_LOCALES.find(l => l.code === code)
  if (!entry) return
  i18n.global.locale.value = code
  try { localStorage.setItem('locale', code) } catch { /* ignore */ }
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('lang', code)
    document.documentElement.setAttribute('dir', entry.rtl ? 'rtl' : 'ltr')
  }
}

// Initialize <html lang> + <html dir> on boot.
if (typeof document !== 'undefined') {
  const code = i18n.global.locale.value
  const entry = SUPPORTED_LOCALES.find(l => l.code === code)
  document.documentElement.setAttribute('lang', code)
  document.documentElement.setAttribute('dir', entry?.rtl ? 'rtl' : 'ltr')
}

export default i18n
