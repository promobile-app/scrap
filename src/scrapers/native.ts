import { randomBytes } from 'node:crypto';
import { request } from 'undici';
import { config } from '../config.js';
import { nextDispatcher } from './proxy.js';

/**
 * Нативный поиск App Store — тот же endpoint, что использует приложение
 * App Store на iPhone. В отличие от legacy iTunes Search API отдаёт
 * полную ранжированную выдачу (200+ позиций) в pageData.bubbles.
 *
 * Channel pool: каждый канал = свой device GUID + свой slot-throttle.
 * Round-robin между каналами даёт ×N throughput, где N = число каналов,
 * потому что Apple видит запросы с разных «устройств» с интервалом
 * `scrapeDelayMs` (а не один общий слот). Число каналов можно крутить
 * через APPLE_CHANNELS (default 4).
 */

/**
 * Storefront-конфигурация App Store по странам.
 * `langs` — доступные языки витрины и их коды Apple (формат X-Apple-Store-Front:
 * `<storefrontId>-<langId>,29`). Первый язык в списке — по умолчанию.
 */
interface Storefront {
  id: number;
  // Явные lang-id Apple для витрины. Опционально: если язык не указан или не
  // найден в карте — шлём `<id>,29` (язык витрины по умолчанию, обычно нативный),
  // который endpoint принимает для любой страны.
  langs?: Record<string, number>;
}

const STOREFRONTS: Record<string, Storefront> = {
  // Для этих витрин знаем явные lang-id (мультиязычная выдача).
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
  // Остальные витрины — только storefront-id (язык по умолчанию). Все id
  // эмпирически проверены на нативном endpoint: выдача по общему терму
  // сверялась с iTunes Search API той же страны (пересечение top-30 заметно
  // выше, чем с выдачей US) — то есть id действительно принадлежит стране,
  // а не отдаёт молча американскую витрину.
  au: { id: 143460 }, nl: { id: 143452 }, se: { id: 143456 }, no: { id: 143457 },
  dk: { id: 143458 }, fi: { id: 143447 }, ie: { id: 143449 }, at: { id: 143445 },
  be: { id: 143446 }, ch: { id: 143459 }, pt: { id: 143453 }, gr: { id: 143448 },
  tr: { id: 143480 }, cz: { id: 143489 }, hu: { id: 143482 }, ro: { id: 143487 },
  sk: { id: 143496 }, br: { id: 143503 }, mx: { id: 143468 }, ar: { id: 143505 },
  cl: { id: 143483 }, co: { id: 143501 }, pe: { id: 143507 }, jp: { id: 143462 },
  cn: { id: 143465 }, kr: { id: 143466 }, hk: { id: 143463 }, tw: { id: 143470 },
  sg: { id: 143464 }, my: { id: 143473 }, th: { id: 143475 }, id: { id: 143476 },
  ph: { id: 143474 }, vn: { id: 143471 }, in: { id: 143467 }, ae: { id: 143481 },
  sa: { id: 143479 }, il: { id: 143491 }, eg: { id: 143516 }, za: { id: 143472 },
  ng: { id: 143561 }, af: { id: 143610 }, pk: { id: 143477 }, nz: { id: 143461 },
  // СНГ / Кавказ / Центральная Азия — без них ранги по этим гео считались
  // по витрине US (fallback ниже) и почти всегда выходили null.
  uz: { id: 143566 }, kz: { id: 143517 }, by: { id: 143565 }, az: { id: 143568 },
  ge: { id: 143615 }, am: { id: 143524 }, kg: { id: 143586 }, tj: { id: 143603 },
  tm: { id: 143604 }, md: { id: 143523 }, mn: { id: 143592 },
  // Европа
  lu: { id: 143451 }, ee: { id: 143518 }, lv: { id: 143519 }, lt: { id: 143520 },
  mt: { id: 143521 }, bg: { id: 143526 }, hr: { id: 143494 }, si: { id: 143499 },
  cy: { id: 143557 }, is: { id: 143558 }, al: { id: 143575 }, mk: { id: 143530 },
  rs: { id: 143500 }, ba: { id: 143612 },
  // Ближний Восток / Северная Африка
  kw: { id: 143493 }, qa: { id: 143498 }, bh: { id: 143559 }, om: { id: 143562 },
  jo: { id: 143528 }, lb: { id: 143497 }, ye: { id: 143571 }, dz: { id: 143563 },
  tn: { id: 143536 },
  // Латинская Америка и Карибы
  ve: { id: 143502 }, gt: { id: 143504 }, sv: { id: 143506 }, do: { id: 143508 },
  ec: { id: 143509 }, hn: { id: 143510 }, ni: { id: 143512 }, py: { id: 143513 },
  uy: { id: 143514 }, bo: { id: 143556 }, cr: { id: 143495 }, pa: { id: 143485 },
  jm: { id: 143511 }, tt: { id: 143551 }, bb: { id: 143541 }, bs: { id: 143539 },
  bz: { id: 143555 }, gy: { id: 143553 }, sr: { id: 143554 }, ag: { id: 143540 },
  ai: { id: 143538 }, bm: { id: 143542 }, vg: { id: 143543 }, ky: { id: 143544 },
  dm: { id: 143545 }, gd: { id: 143546 }, ms: { id: 143547 }, kn: { id: 143548 },
  lc: { id: 143549 }, vc: { id: 143550 }, tc: { id: 143552 },
  // Азия и Океания
  np: { id: 143484 }, lk: { id: 143486 }, mo: { id: 143515 }, bn: { id: 143560 },
  bt: { id: 143577 }, kh: { id: 143579 }, la: { id: 143587 }, fj: { id: 143583 },
  fm: { id: 143591 }, pw: { id: 143595 }, pg: { id: 143597 }, sb: { id: 143601 },
  // Африка
  ke: { id: 143529 }, gh: { id: 143573 }, tz: { id: 143572 }, ug: { id: 143537 },
  bw: { id: 143525 }, mg: { id: 143531 }, ml: { id: 143532 }, mu: { id: 143533 },
  ne: { id: 143534 }, sn: { id: 143535 }, ao: { id: 143564 }, bj: { id: 143576 },
  bf: { id: 143578 }, cv: { id: 143580 }, td: { id: 143581 }, cg: { id: 143582 },
  gm: { id: 143584 }, gw: { id: 143585 }, lr: { id: 143588 }, mw: { id: 143589 },
  mr: { id: 143590 }, mz: { id: 143593 }, na: { id: 143594 }, st: { id: 143598 },
  sc: { id: 143599 }, sl: { id: 143600 }, sz: { id: 143602 }, zw: { id: 143605 },
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

// --- Channel pool ----------------------------------------------------------
// Один канал = «виртуальное устройство» со своим GUID. Round-robin между
// каналами позволяет параллельно слать несколько запросов в Apple с
// разными «отпечатками» — slot-throttle на каждом канале свой.

class AppleChannel {
  readonly guid: string;
  nextSlotAt = 0;
  inFlight = 0;

  constructor() {
    this.guid = randomBytes(6).toString('hex').toUpperCase();
  }

  async waitSlot(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlotAt);
    this.nextSlotAt = slot + config.scrapeDelayMs;
    if (slot > now) await sleep(slot - now);
  }

  /** При 429/403 — увеличенный backoff на этом канале, чтобы притормозить
   *  и остальные worker'ы, использующие тот же канал. */
  bumpPenalty(ms = 8000): void {
    this.nextSlotAt = Math.max(this.nextSlotAt, Date.now() + ms);
  }

  acquire(): void { this.inFlight++; }
  release(): void { this.inFlight = Math.max(0, this.inFlight - 1); }
}

const CHANNEL_COUNT = Number(process.env.APPLE_CHANNELS ?? 6);
const CHANNELS: AppleChannel[] = Array.from({ length: CHANNEL_COUNT }, () => new AppleChannel());

// Round-robin: берём канал с минимальным inFlight, чтобы нагрузка
// распределялась равномерно (а не «канал 0, канал 0, канал 1, ...»).
let channelCursor = 0;
function pickChannel(): AppleChannel {
  // Сначала ищем полностью свободный канал; если все заняты — round-robin.
  let best: AppleChannel | null = null;
  for (let i = 0; i < CHANNELS.length; i++) {
    const c = CHANNELS[(channelCursor + i) % CHANNELS.length]!;
    if (c.inFlight === 0) { best = c; channelCursor = (channelCursor + i + 1) % CHANNELS.length; break; }
  }
  const ch = best ?? CHANNELS[channelCursor]!;
  channelCursor = (channelCursor + 1) % CHANNELS.length;
  ch.acquire();
  return ch;
}

/** Берёт канал, ждёт его slot и возвращает. Освобождение — releaseChannel(). */
async function acquireChannel(): Promise<AppleChannel> {
  const ch = pickChannel();
  await ch.waitSlot();
  return ch;
}

function releaseChannel(ch: AppleChannel): void {
  ch.release();
}

/** Собирает значение X-Apple-Store-Front для страны и (опц.) языка витрины. */
/**
 * Строка заголовка X-Apple-Store-Front для страны/языка (без суффикса t:native).
 * Если запрошен язык, известный для витрины, — `<id>-<langId>,29`; иначе
 * `<id>,29` (язык витрины по умолчанию), который endpoint принимает для всех стран.
 */
export function storeFront(country: string, language?: string): string {
  const known = STOREFRONTS[country.toLowerCase()];
  // Витрины нет в карте — берём US, но громко предупреждаем: молчаливый
  // откат отдаёт американскую выдачу под видом запрошенного гео, и ранг по
  // локальному приложению выходит null (см. UZ до добавления 143566).
  if (!known) {
    console.warn(
      `[native] storefront для country=${country} неизвестен — выдача будет по витрине US, ранги для локальных приложений будут неверными`,
    );
  }
  const sf = known ?? STOREFRONTS.us!;
  const langId = language ? sf.langs?.[language.toLowerCase()] : undefined;
  return langId ? `${sf.id}-${langId},29` : `${sf.id},29`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    const channel = await acquireChannel();
    try {
      const url = new URL(SEARCH_URL);
      url.searchParams.set('clientApplication', 'Software');
      url.searchParams.set('term', term);
      url.searchParams.set('guid', channel.guid);

      const headers = {
        'X-Apple-Store-Front': `${storeFront(country, language)} t:native`,
        'User-Agent': NATIVE_UA,
        'X-Apple-Client-Application': 'com.apple.AppStore',
        Accept: 'application/json',
      };

      // Один прокси на весь запрос (включая редирект-хопы) — round-robin по пулу.
      const dispatcher = nextDispatcher();
      const reqOpts = dispatcher ? { method: 'GET' as const, headers, dispatcher } : { method: 'GET' as const, headers };
      // MZSearch отвечает 302 на MZStore — следуем за редиректом вручную.
      let target: string | URL = url;
      let res = await request(target, reqOpts);
      for (let hop = 0; hop < 3 && res.statusCode >= 300 && res.statusCode < 400; hop++) {
        const loc = res.headers['location'];
        if (!loc) break;
        target = new URL(String(loc), target);
        res = await request(target, reqOpts);
      }
      if (res.statusCode >= 400) throw new Error(`HTTP ${res.statusCode}`);

      const body = (await res.body.json()) as NativeSearchResponse;
      const bubble = body.pageData?.bubbles?.[0];
      return (bubble?.results ?? [])
        .filter((r) => r.entity === 'software')
        .map((r) => r.id);
    } catch (err) {
      lastErr = err;
      // При 429/403 (ограничение Apple) — увеличенная пауза на этом канале,
      // чтобы притормозить и остальные worker'ы на нём.
      const throttled = /HTTP (429|403)/.test(String(err));
      if (throttled) channel.bumpPenalty();
      await sleep((throttled ? 4000 : 500) * 2 ** attempt + Math.random() * 400);
    } finally {
      releaseChannel(channel);
    }
  }
  throw new Error(`nativeSearchIds failed: ${String(lastErr)}`);
}
