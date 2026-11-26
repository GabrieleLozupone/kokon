// UI language. Every text the app shows comes from src/locales/<lang>.json through t(); English
// (en.json) is the source and the fallback for any key a language doesn't have yet.
//
// Keys are flat, "<area>.<name>" (e.g. "settings.appearance"). Variables are written {name} and
// filled from t()'s second argument. Plurals: keys "<key>_one" / "<key>_other" (and "_many" where a
// language needs it), called as t("<key>", { count }). Text with markup inside (bold, a link) uses
// <Trans> from components/Trans.tsx with tags like <b>…</b> in the string.
//
// The choice is kept in localStorage (like the theme); without one, Kokon follows the system
// language when it has it, else English. Changing it re-renders the whole app (main.tsx).
import { useSyncExternalStore } from "react";
import en from "../locales/en.json";
import it from "../locales/it.json";
import es from "../locales/es.json";
import fr from "../locales/fr.json";

type Dict = Record<string, string>;
type EnKey = keyof typeof en;
type PluralBase<K> = K extends `${infer B}_${"one" | "other" | "many"}` ? B : never;
/** Every key in en.json, plus the base name of each plural key. */
export type MsgKey = EnKey | PluralBase<EnKey>;

/** The languages Kokon ships, each named in its own language (the picker never translates them). */
export const LANGUAGES = [
  { code: "en", name: "English" },
  { code: "it", name: "Italiano" },
  { code: "es", name: "Español" },
  { code: "fr", name: "Français" },
] as const;
export type Lang = (typeof LANGUAGES)[number]["code"];
export type LangChoice = Lang | "system";

const DICTS: Record<Lang, Dict> = { en, it: it as Dict, es: es as Dict, fr: fr as Dict };
const KEY = "qls.lang.v1";

const isLang = (v: unknown): v is Lang => LANGUAGES.some((l) => l.code === v);

/** The language the system asks for, when Kokon has it: "it-IT" → "it". */
export function systemLang(langs: readonly string[] = typeof navigator === "undefined" ? [] : navigator.languages?.length ? navigator.languages : [navigator.language]): Lang {
  for (const tag of langs) {
    const base = (tag || "").toLowerCase().split(/[-_]/)[0];
    if (isLang(base)) return base;
  }
  return "en";
}

export function langChoice(): LangChoice {
  try {
    const v = localStorage.getItem(KEY);
    if (isLang(v)) return v;
  } catch {
    /* storage unavailable */
  }
  return "system";
}

let current: Lang = resolve(langChoice());
const listeners = new Set<() => void>();

function resolve(c: LangChoice): Lang {
  return c === "system" ? systemLang() : c;
}

function applyDocument() {
  if (typeof document !== "undefined") document.documentElement.lang = current;
}
applyDocument();

/** The language in use now. */
export const lang = (): Lang => current;

export function setLangChoice(c: LangChoice) {
  try {
    if (c === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, c);
  } catch {
    /* storage unavailable: applies until restart */
  }
  const next = resolve(c);
  if (next === current) return;
  current = next;
  applyDocument();
  listeners.forEach((f) => f());
}

/** Re-renders the caller when the language changes (main.tsx uses it to redraw the app). */
export function useLang(): Lang {
  return useSyncExternalStore(
    (f) => (listeners.add(f), () => void listeners.delete(f)),
    () => current,
    () => current,
  );
}

export type Vars = Record<string, string | number>;

function lookup(key: string, dict: Dict): string | undefined {
  return dict[key];
}

/** The raw string for a key in a language (plural form picked from vars.count), English if missing. */
export function message(key: string, vars?: Vars, l: Lang = current): string {
  const dict = DICTS[l];
  const count = vars?.count;
  if (typeof count === "number") {
    const form = new Intl.PluralRules(l).select(count);
    const forms = [`${key}_${form}`, `${key}_other`];
    for (const k of forms) {
      const s = lookup(k, dict);
      if (s !== undefined) return s;
    }
    const enForm = new Intl.PluralRules("en").select(count);
    for (const k of [`${key}_${enForm}`, `${key}_other`]) {
      const s = lookup(k, DICTS.en);
      if (s !== undefined) return s;
    }
  }
  return lookup(key, dict) ?? lookup(key, DICTS.en) ?? key;
}

/** Fills {name} placeholders; unknown ones stay as written so a mistake is visible, not blank. */
export function fill(s: string, vars?: Vars): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

/** The text for `key` in the current language, with {variables} filled. */
export function t(key: MsgKey, vars?: Vars): string {
  return fill(message(key, vars), vars);
}

/** Dates and numbers in the current language. */
export const formatDate = (d: Date | number, opts?: Intl.DateTimeFormatOptions) => new Date(d).toLocaleDateString(current, opts);
export const formatDateTime = (d: Date | number, opts?: Intl.DateTimeFormatOptions) => new Date(d).toLocaleString(current, opts);
export const formatNumber = (n: number, opts?: Intl.NumberFormatOptions) => n.toLocaleString(current, opts);

/** For tests: the dictionaries, by language. */
export const dictionaries = DICTS;
