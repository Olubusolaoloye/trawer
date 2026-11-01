/**
 * Copy lives in JSON per locale. English is the fallback; pcm (Pidgin), yo (Yoruba), ha (Hausa)
 * and ig (Igbo) files are ready for translators — any missing key falls back to English.
 */
import en from './en.json';

export type MessageKey = keyof typeof en;
export const LOCALES = ['en', 'pcm', 'yo', 'ha', 'ig'] as const;
export type Locale = (typeof LOCALES)[number];

const loaders: Record<Exclude<Locale, 'en'>, () => Promise<{ default: Record<string, string> }>> = {
  pcm: () => import('./pcm.json'),
  yo: () => import('./yo.json'),
  ha: () => import('./ha.json'),
  ig: () => import('./ig.json'),
};

let active: Record<string, string> = en;

export async function setLocale(locale: Locale): Promise<void> {
  active = locale === 'en' ? en : { ...en, ...(await loaders[locale]()).default };
  try { localStorage.setItem('trawer:locale', locale); } catch { /* ignore */ }
  document.documentElement.lang = locale === 'pcm' ? 'en-NG' : locale;
}

export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  let s = active[key] ?? en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

export function errorText(code: string | undefined): string {
  const k = `error.${code}` as MessageKey;
  return k in en ? t(k) : t('error.default');
}
