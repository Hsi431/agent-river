export const DEFAULT_LOCALE = "en";
export const LOCALE_COOKIE_NAME = "agent_river_locale";

const TRANSLATIONS = {
  en: {
    "language.switch": "Language",
    "language.en": "English",
    "language.zh-Hant": "繁體中文",
  },
  "zh-Hant": {
    "language.switch": "語言",
    "language.en": "English",
    "language.zh-Hant": "繁體中文",
  },
};

export function normalizeLocale(value) {
  return matchLocale(value) || DEFAULT_LOCALE;
}

export function detectLocale({ cookieHeader = "", acceptLanguage = "" } = {}) {
  const remembered = matchLocale(readCookie(cookieHeader, LOCALE_COOKIE_NAME));
  if (remembered) return remembered;
  for (const range of languageRanges(acceptLanguage)) {
    const locale = matchLocale(range);
    if (locale) return locale;
  }
  return DEFAULT_LOCALE;
}

export function createTranslator(locale) {
  const selected = normalizeLocale(locale);
  return (key) => TRANSLATIONS[selected]?.[key] ?? TRANSLATIONS.en[key] ?? String(key);
}

export function localeCookie(locale) {
  return `${LOCALE_COOKIE_NAME}=${encodeURIComponent(normalizeLocale(locale))}; Max-Age=31536000; HttpOnly; SameSite=Strict; Path=/`;
}

function matchLocale(value) {
  const normalized = String(value || "").trim().replaceAll("_", "-").toLowerCase();
  if (normalized === "en" || normalized.startsWith("en-")) return "en";
  if (normalized === "zh" || normalized === "zh-hant" || normalized.startsWith("zh-hant-")
    || normalized === "zh-tw" || normalized === "zh-hk" || normalized === "zh-mo") return "zh-Hant";
  return null;
}

function languageRanges(header) {
  return String(header || "").split(",")
    .map((entry, index) => {
      const [range, ...parameters] = entry.trim().split(";");
      const quality = parameters.find((parameter) => /^q=/i.test(parameter.trim()));
      const q = quality ? Number(quality.trim().slice(2)) : 1;
      return { range, q: Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0, index };
    })
    .filter((entry) => entry.range && entry.q > 0)
    .sort((left, right) => right.q - left.q || left.index - right.index)
    .map((entry) => entry.range);
}

function readCookie(header, name) {
  for (const part of String(header || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key !== name) continue;
    try {
      return decodeURIComponent(rest.join("="));
    } catch {
      return "";
    }
  }
  return "";
}
