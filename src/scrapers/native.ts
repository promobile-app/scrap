import { randomBytes } from 'node:crypto';
import { request } from 'undici';
import { config } from '../config.js';

/**
 * Нативный поиск App Store — тот же endpoint, что использует приложение
 * App Store на iPhone. В отличие от legacy iTunes Search API отдаёт
 * полную ранжированную выдачу (200+ позиций) в pageData.bubbles.
 */

/**
 * Storefront-конфигурация App Store по странам.
 * `langs` — доступные языки витрины и их коды Apple (формат X-Apple-Store-Front:
 * `<storefrontId>-<langId>,29`). Первый язык в списке — по умолчанию.
 */
interface Storefront {
  id: number;
  langs: Record<string, number>;
}

const STOREFRONTS: Record<string, Storefront> = {
  us: { id: 143441, langs: { en: 1 } },
  gb: { id: 143444, langs: { en: 2 } },
  de: { id: 143443, langs: { de: 4, en: 2 } },
  ua: { id: 143492, langs: { ru: 16, en: 2 } },
  ru: { id: 143469, langs: { ru: 16, en: 2 } },
  pl: { id: 143478, langs: { pl: 19, en: 2 } },
  fr: { id: 143442, langs: { fr: 3, en: 2 } },
  es: { id: 143454, langs: { es: 8, en: 2 } },
  it: { id: 143450, langs: { it: 7, en: 2 } },
  ca: { id: 143455, langs: { en: 6, fr: 3 } },
};

export const SUPPORTED_COUNTRIES = Object.keys(STOREFRONTS);

/** Доступные языки витрины для страны (первый — по умолчанию). */
export function storeLanguages(country: string): string[] {
  return Object.keys(STOREFRONTS[country.toLowerCase()]?.langs ?? { en: 1 });
}

// GUID устройства — генерируется один раз на процесс (16 hex, как MAC-производное).
const DEVICE_GUID = randomBytes(6).toString('hex').toUpperCase();

const NATIVE_UA =
  'AppStore/3.0 iOS/17.5.1 model/iPhone15,3 hwp/t8120 build/21F90 (6; dt:268) AMS/1';

const SEARCH_URL = 'https://search.itunes.apple.com/WebObjects/MZSearch.woa/wa/search';

/** Собирает значение X-Apple-Store-Front для страны и (опц.) языка витрины. */
function storeFront(country: string, language?: string): string {
  const sf = STOREFRONTS[country.toLowerCase()] ?? STOREFRONTS.us!;
  const langCodes = sf.langs;
  const defaultLang = Object.keys(langCodes)[0]!;
  const langId = langCodes[language?.toLowerCase() ?? ''] ?? langCodes[defaultLang]!;
  return `${sf.id}-${langId},29`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Слот-троттлинг: каждый вызов резервирует следующий временной слот.
// Так параллельные вызовы не уходят к Apple пачкой (иначе — 429/403).
let nextSlotAt = 0;
async function throttleSlot(): Promise<void> {
  const now = Date.now();
  const slot = Math.max(now, nextSlotAt);
  nextSlotAt = slot + config.scrapeDelayMs;
  if (slot > now) await sleep(slot - now);
}

interface NativeSearchResponse {
  pageData?: {
    bubbles?: { results?: { id: string; entity: string }[] }[];
  };
}

/**
 * Полный упорядоченный список App ID по поисковому запросу — реальная
 * ранжированная выдача App Store для указанной страны.
 */
export async function nativeSearchIds(
  term: string,
  country = config.defaultCountry,
  language?: string,
): Promise<string[]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < config.scrapeMaxRetries; attempt++) {
    await throttleSlot();
    try {
      const url = new URL(SEARCH_URL);
      url.searchParams.set('clientApplication', 'Software');
      url.searchParams.set('term', term);
      url.searchParams.set('guid', DEVICE_GUID);

      const headers = {
        'X-Apple-Store-Front': `${storeFront(country, language)} t:native`,
        'User-Agent': NATIVE_UA,
        'X-Apple-Client-Application': 'com.apple.AppStore',
        Accept: 'application/json',
      };

      // MZSearch отвечает 302 на MZStore — следуем за редиректом вручную.
      let target: string | URL = url;
      let res = await request(target, { method: 'GET', headers });
      for (let hop = 0; hop < 3 && res.statusCode >= 300 && res.statusCode < 400; hop++) {
        const loc = res.headers['location'];
        if (!loc) break;
        target = new URL(String(loc), target);
        res = await request(target, { method: 'GET', headers });
      }
      if (res.statusCode >= 400) throw new Error(`HTTP ${res.statusCode}`);

      const body = (await res.body.json()) as NativeSearchResponse;
      const bubble = body.pageData?.bubbles?.[0];
      return (bubble?.results ?? [])
        .filter((r) => r.entity === 'software')
        .map((r) => r.id);
    } catch (err) {
      lastErr = err;
      // При 429/403 (ограничение Apple) — увеличенная пауза + сдвиг общего слота,
      // чтобы притормозить и остальные параллельные запросы.
      const throttled = /HTTP (429|403)/.test(String(err));
      if (throttled) nextSlotAt = Math.max(nextSlotAt, Date.now() + 8000);
      await sleep((throttled ? 4000 : 500) * 2 ** attempt + Math.random() * 400);
    }
  }
  throw new Error(`nativeSearchIds failed: ${String(lastErr)}`);
}
