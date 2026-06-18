import gplay from 'google-play-scraper';
import { request } from 'undici';
import { config } from '../config.js';
import { gpRequestOptions, nextDispatcher } from './proxy.js';

/**
 * Скрейпер Google Play. У Play Store нет официального API.
 *
 * gplay.app / gplay.suggest берём из google-play-scraper (работают).
 * НО gplay.search в библиотеке сломан: он ходит в /work/search, который Google
 * теперь отдаёт пустым, и маппинг приложений устарел. Поэтому поиск реализуем
 * сами: fetch /store/search + парс встроенного AF_initDataCallback (ds:4).
 *
 * appId в Google Play — это имя пакета (строка), напр. "com.moneyveo.app".
 */

export interface GpAppInfo {
  appId: string;
  title: string;
  developer: string;
  score: number;
  ratings: number;
  installs: string;
  /** Нижняя граница установок числом (для аналитики). 0 если неизвестно. */
  minInstalls: number;
  genre: string;
  icon: string;
  url: string;
  free: boolean;
  description: string;
  summary: string;
}

// Язык витрины по стране (Play Store учитывает lang при ранжировании).
const COUNTRY_LANG: Record<string, string> = {
  us: 'en', gb: 'en', de: 'de', ua: 'uk', ru: 'ru',
  pl: 'pl', fr: 'fr', es: 'es', it: 'it', ca: 'en',
};

function langOf(country: string): string {
  return COUNTRY_LANG[country.toLowerCase()] ?? 'en';
}

interface GpRaw {
  appId: string;
  title: string;
  developer: string | { devId?: string };
  score?: number;
  ratings?: number;
  installs?: string;
  minInstalls?: number;
  genre?: string;
  icon?: string;
  url?: string;
  free?: boolean;
  description?: string;
  summary?: string;
}

/** "10,000,000+" / "10 000 000+" → 10000000. Возвращает 0 если не распознано. */
function parseInstalls(s?: string): number {
  if (!s) return 0;
  const digits = s.replace(/[^\d]/g, '');
  return digits ? Number(digits) : 0;
}

function mapApp(r: GpRaw): GpAppInfo {
  return {
    appId: r.appId,
    title: r.title,
    developer: typeof r.developer === 'string' ? r.developer : (r.developer?.devId ?? ''),
    score: r.score ?? 0,
    ratings: r.ratings ?? 0,
    installs: r.installs ?? '',
    minInstalls: r.minInstalls ?? parseInstalls(r.installs),
    genre: r.genre ?? '',
    icon: r.icon ?? '',
    url: r.url ?? '',
    free: r.free ?? true,
    description: r.description ?? '',
    summary: r.summary ?? '',
  };
}

/** Метаданные приложения Google Play по имени пакета. */
export async function gpAppLookup(
  appId: string,
  country = config.defaultCountry,
): Promise<GpAppInfo | null> {
  try {
    const r = await gplay.app({
      appId, country, lang: langOf(country), requestOptions: gpRequestOptions(),
    } as Parameters<typeof gplay.app>[0]);
    return mapApp(r as GpRaw);
  } catch {
    return null;
  }
}

const GP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Достаёт data-массивы из AF_initDataCallback по ключам ds:N. */
function parseInitData(html: string): Record<string, unknown> {
  const re = /AF_initDataCallback\((\{.*?\})\);<\/script>/gs;
  const out: Record<string, unknown> = {};
  for (const m of html.matchAll(re)) {
    const block = m[1]!;
    const key = block.match(/key:\s*'(ds:\d+)'/)?.[1];
    const dataRaw = block.match(/data:(\[.*\])\s*,\s*sideChannel/s)?.[1];
    if (key && dataRaw) {
      try {
        out[key] = JSON.parse(dataRaw);
      } catch {
        /* пропускаем нечитаемый блок */
      }
    }
  }
  return out;
}

const PKG_RE = /^[a-z][\w]*(\.[\w]+)+$/i;

/** Карточка приложения: app = el[0], где app[0][0] = appId (строка), app[3] = title. */
function isCard(el: unknown): boolean {
  if (!Array.isArray(el)) return false;
  const app = el[0];
  return (
    Array.isArray(app) &&
    Array.isArray(app[0]) &&
    typeof app[0][0] === 'string' &&
    PKG_RE.test(app[0][0]) &&
    typeof app[3] === 'string'
  );
}

/** Рекурсивно ищет САМЫЙ длинный массив карточек приложений (устойчиво к сдвигу индексов). */
function findAppList(node: unknown, best: unknown[] = []): unknown[] {
  if (!Array.isArray(node)) return best;
  const cards = node.filter(isCard);
  if (cards.length >= 3 && cards.length > best.length) best = cards;
  for (const child of node) best = findAppList(child, best);
  return best;
}

/**
 * Featured/«точный» результат поиска. Google Play рендерит топовое совпадение
 * (для брендовых запросов — само приложение, напр. Roblox по "roblox") ОТДЕЛЬНЫМ
 * hero-блоком с иной формой: appId зашит в URL details?id=, а не в app[0][0],
 * поэтому isCard/findAppList его не видят, и в выдаче он терялся.
 *
 * Достаём без сетевых вызовов: первый в DFS-порядке details?id=PKG, которого нет
 * в сетке, чей ближайший контейнер имеет строковый заголовок в [0][0]. Для
 * небрендовых запросов hero обычно отсутствует или уже в сетке → null.
 */
function extractHero(data: Record<string, unknown>, gridIds: Set<string>): GpAppInfo | null {
  let found: GpAppInfo | null = null;
  const at = (node: unknown, parts: number[]): unknown =>
    parts.reduce<unknown>((n, i) => (Array.isArray(n) ? n[i] : undefined), node);
  function walk(root: unknown, node: unknown, path: number[]): void {
    if (found) return;
    if (typeof node === 'string') {
      const pkg = node.match(/details\?id=([\w.]+)/)?.[1];
      if (pkg && PKG_RE.test(pkg) && !gridIds.has(pkg)) {
        for (let up = 1; up <= 10; up++) {
          const a = at(root, path.slice(0, path.length - up));
          const title = Array.isArray(a) && Array.isArray(a[0]) ? a[0][0] : undefined;
          if (typeof title === 'string' && title.length > 0 && title.length < 80 && !title.includes('http')) {
            found = {
              appId: pkg, title, developer: '', score: 0, ratings: 0, installs: '',
              minInstalls: 0, genre: '', icon: '',
              url: 'https://play.google.com/store/apps/details?id=' + pkg,
              free: true, description: '', summary: '',
            };
            return;
          }
        }
      }
      return;
    }
    if (Array.isArray(node)) node.forEach((c, i) => { path.push(i); walk(root, c, path); path.pop(); });
  }
  for (const v of Object.values(data)) { walk(v, v, []); if (found) break; }
  return found;
}

/** Маппинг одной карточки выдачи в GpAppInfo (поля выдачи; ratings/installs — из деталей). */
function mapCard(el: unknown): GpAppInfo | null {
  const app = (el as unknown[])[0] as unknown[];
  const at = (path: number[]): unknown => path.reduce<unknown>((n, i) => (Array.isArray(n) ? n[i] : undefined), app);
  const appId = at([0, 0]) as string | undefined;
  const title = at([3]) as string | undefined;
  if (!appId || !title) return null;
  const score = (at([4, 1]) as number | undefined) ?? 0;
  return {
    appId,
    title,
    developer: (at([14]) as string | undefined) ?? '',
    score,
    ratings: 0, // выдача не отдаёт число отзывов — берётся из gpAppLookup
    installs: '',
    minInstalls: 0,
    genre: (at([5]) as string | undefined) ?? '',
    icon: (at([1, 3, 2]) as string | undefined) ?? '',
    url: 'https://play.google.com/store/apps/details?id=' + appId,
    free: (at([8, 1, 0, 0]) as number | undefined) === 0,
    description: '',
    summary: '',
  };
}

/**
 * Поисковая выдача Google Play — упорядоченный список приложений.
 * Свой парсер /store/search (библиотечный gplay.search сломан, см. шапку файла).
 *
 * ПРЕДЕЛ ГЛУБИНЫ: после редизайна 2022 веб-версия Play отдаёт ТОЛЬКО первую
 * «страницу» (~15-30 приложений) и больше НЕ имеет пагинации вовсе — проверено
 * перехватом трафика реального Chrome (страница рендерится целиком, infinite
 * scroll отсутствует, continuation-RPC не вызывается; старый batchexecute
 * qnKhOb отвечает PlayDataError на новые токены). Позиции глубже ~30 веб-схеме
 * недоступны в принципе; их отдаёт только мобильный protobuf-API (Finsky,
 * нужна регистрация устройства) — кандидат на отдельную интеграцию.
 * Поэтому rank=null при totalResults>0 значит «глубже выдачи», а не «нет в сторе».
 */
export async function gpSearch(
  term: string,
  country = config.defaultCountry,
  num = 100,
): Promise<GpAppInfo[]> {
  const url =
    `https://play.google.com/store/search?q=${encodeURIComponent(term)}` +
    `&c=apps&hl=${langOf(country)}&gl=${country}`;
  const dispatcher = nextDispatcher();
  const res = await request(url, {
    method: 'GET',
    headers: { 'User-Agent': GP_UA, 'Accept-Language': `${langOf(country)};q=0.9` },
    ...(dispatcher ? { dispatcher } : {}),
  });
  if (res.statusCode >= 400) {
    throw new Error(`gpSearch HTTP ${res.statusCode} для "${term}"`);
  }
  const html = await res.body.text();
  const data = parseInitData(html);

  let list: unknown[] = [];
  for (const key of Object.keys(data)) {
    list = findAppList(data[key], list);
  }

  const apps: GpAppInfo[] = [];
  const seen = new Set<string>();
  for (const el of list) {
    const app = mapCard(el);
    if (app && !seen.has(app.appId)) {
      seen.add(app.appId);
      apps.push(app);
    }
  }

  // Точный/featured результат (hero) Google Play рисует над сеткой — ставим первым,
  // иначе брендовый запрос терял само приложение (Roblox по "roblox").
  const hero = extractHero(data, seen);
  if (hero) apps.unshift(hero);

  return apps.slice(0, num);
}

/** Позиция приложения по ключевому слову в выдаче Google Play. */
export async function gpGetRank(
  appId: string,
  term: string,
  country = config.defaultCountry,
): Promise<{ rank: number | null; total: number }> {
  const results = await gpSearch(term, country, 250);
  const idx = results.findIndex((a) => a.appId === appId);
  return { rank: idx === -1 ? null : idx + 1, total: results.length };
}

/** Autocomplete-подсказки Google Play. */
export async function gpSuggest(
  term: string,
  country = config.defaultCountry,
): Promise<string[]> {
  try {
    return await gplay.suggest({
      term, country, lang: langOf(country), requestOptions: gpRequestOptions(),
    } as Parameters<typeof gplay.suggest>[0]);
  } catch {
    return [];
  }
}

/** Топ-чарт Google Play (бесплатные приложения по стране). */
export async function gpTopChart(
  country = config.defaultCountry,
  num = 100,
): Promise<GpAppInfo[]> {
  // Типы google-play-scraper не экспонируют ключи enum — обращаемся через cast.
  const enums = gplay as unknown as {
    collection: Record<string, string>;
    category: Record<string, string>;
  };
  const results = await gplay.list({
    collection: enums.collection.TOP_FREE,
    category: enums.category.APPLICATION,
    country,
    lang: langOf(country),
    num,
    requestOptions: gpRequestOptions(),
  } as Parameters<typeof gplay.list>[0]);
  return (results as GpRaw[]).map(mapApp);
}
