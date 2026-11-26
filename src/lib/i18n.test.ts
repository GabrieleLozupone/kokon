import { describe, expect, it } from "vitest";
import { dictionaries, fill, LANGUAGES, message, systemLang } from "./i18n";
import { renderTags } from "../components/Trans";

const en = dictionaries.en;
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const tags = (s: string) => [...s.matchAll(/<(\w+)>/g)].map((m) => m[1]).sort();
const pluralBase = (k: string) => k.replace(/_(one|other|many)$/, "");

describe("i18n", () => {
  it("picks the system language when Kokon has it", () => {
    expect(systemLang(["it-IT", "en-US"])).toBe("it");
    expect(systemLang(["de-DE", "es-MX"])).toBe("es");
    expect(systemLang(["fr_CA"])).toBe("fr");
    expect(systemLang(["ja-JP"])).toBe("en");
    expect(systemLang([])).toBe("en");
  });

  it("fills variables and keeps unknown ones visible", () => {
    expect(fill("{n} of {total}", { n: 2, total: 5 })).toBe("2 of 5");
    expect(fill("{n} left", {})).toBe("{n} left");
  });

  it("falls back to English, then to the key", () => {
    expect(message("__missing__", undefined, "it")).toBe("__missing__");
    const k = Object.keys(en)[0];
    expect(message(k, undefined, "en")).toBe(en[k as keyof typeof en]);
  });

  it("splits tagged text", () => {
    const parts = renderTags("Press <kbd>Enter</kbd> now", { kbd: (s) => `[${s}]` });
    expect(parts.length).toBe(3);
    expect(parts[0]).toBe("Press ");
    expect(parts[2]).toBe(" now");
  });

  for (const { code } of LANGUAGES.filter((l) => l.code !== "en")) {
    const dict = dictionaries[code];
    describe(code, () => {
      it("has only keys that English has", () => {
        const enBases = new Set(Object.keys(en).map(pluralBase));
        const extra = Object.keys(dict).filter((k) => !(k in en) && !enBases.has(pluralBase(k)));
        expect(extra).toEqual([]);
      });

      it("keeps every {variable} and <tag> of the English text", () => {
        const bad: string[] = [];
        for (const [k, s] of Object.entries(dict)) {
          const src = en[k as keyof typeof en] ?? en[`${pluralBase(k)}_other` as keyof typeof en];
          if (src === undefined) continue;
          // A plural form may drop {count} ("one image"), but must not invent variables.
          const want = placeholders(src).filter((p) => !(p === "count" && /_(one|many)$/.test(k)));
          const got = placeholders(s);
          if (!want.every((p) => got.includes(p)) || !got.every((p) => placeholders(src).includes(p))) bad.push(`${k}: vars`);
          if (tags(s).join() !== tags(src).join()) bad.push(`${k}: tags`);
        }
        expect(bad).toEqual([]);
      });

      it("translates every English key", () => {
        const missing = Object.keys(en).filter((k) => {
          if (k in dict) return false;
          // a plural key is covered if the language has the same base with any form
          return !Object.keys(dict).some((d) => pluralBase(d) === pluralBase(k) && pluralBase(k) !== k);
        });
        expect(missing).toEqual([]);
      });
    });
  }
});
