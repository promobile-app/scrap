import { URL_FDFE } from './auth.js';
import { defaultHeaders, type AuthState } from './headers.js';
import { playGet } from './http.js';
import { decodeProto } from './proto.js';

/**
 * Поиск по выдаче Google Play через Finsky.
 *
 * Главное отличие от веб-парсера (scrapers/googleplay.ts): у кластера выдачи
 * есть containerMetadata.nextPageUrl, то есть выдача листается. Веб-версия Play
 * с 2022 отдаёт одну страницу (~20-30 приложений) и пагинации не имеет вовсе,
 * поэтому позиции глубже топ-30 там недостижимы в принципе.
 *
 * Порт helpers/SearchHelper.kt + helpers/NativeHelper.kt из AuroraOSS/gplayapi
 * (GPL-3.0-or-later).
 */

const URL_SEARCH = `${URL_FDFE}/search`;

/** Item.type == 1 — карточка приложения; остальные типы это баннеры и промо. */
const ITEM_TYPE_APP = 1;

export interface FinskyApp {
  packageName: string;
  title: string;
  developer: string;
  /** Точное число установок (AppDetails.downloadCount), 0 если не пришло. */
  installs: number;
  /** Подпись установок как её рисует Play («10B+»), если пришла. */
  installsLabel: string;
  ratings: number;
  rating: number;
}

export interface FinskySearchResult {
  term: string;
  apps: FinskyApp[];
  /** Сколько страниц выдачи удалось пройти. */
  pages: number;
  /** Заголовки кластеров — для диагностики: промо-кластеры сюда не попадают. */
  clusterTitle: string;
  /** true, если сервер отдал ещё одну страницу, а мы упёрлись в maxPages. */
  truncated: boolean;
}

interface ProtoItem {
  id?: string;
  type?: number;
  title?: string;
  creator?: string;
  subItem?: ProtoItem[];
  containerMetadata?: { nextPageUrl?: string };
  details?: {
    appDetails?: {
      packageName?: string;
      title?: string;
      developerName?: string;
      downloadCount?: string;
      downloadLabelAbbreviated?: string;
      downloadLabel?: string;
    };
  };
  aggregateRating?: { starRating?: number; ratingsCount?: string };
}

interface ProtoListResponse {
  item?: ProtoItem;
}

interface ProtoWrapper {
  payload?: { listResponse?: ProtoListResponse; searchResponse?: unknown };
  preFetch?: { response?: { payload?: { listResponse?: ProtoListResponse } } };
}

/** Ответ приходит либо в payload, либо в preFetch (как в getPrefetchPayLoad). */
function listResponseOf(wrapper: ProtoWrapper): ProtoListResponse | undefined {
  return wrapper.preFetch?.response?.payload?.listResponse ?? wrapper.payload?.listResponse;
}

function toApp(item: ProtoItem): FinskyApp | null {
  const details = item.details?.appDetails;
  const packageName = details?.packageName ?? item.id;
  if (!packageName) return null;
  return {
    packageName,
    title: details?.title ?? item.title ?? '',
    developer: details?.developerName ?? item.creator ?? '',
    installs: Number(details?.downloadCount ?? 0) || 0,
    installsLabel: details?.downloadLabelAbbreviated ?? details?.downloadLabel ?? '',
    ratings: Number(item.aggregateRating?.ratingsCount ?? 0) || 0,
    rating: item.aggregateRating?.starRating ?? 0,
  };
}

function appsOf(cluster: ProtoItem): FinskyApp[] {
  return (cluster.subItem ?? [])
    .filter((sub) => sub.type === ITEM_TYPE_APP)
    .map(toApp)
    .filter((a): a is FinskyApp => a !== null);
}

async function fetchWrapper(
  auth: AuthState,
  url: string,
  query: Record<string, string> = {},
): Promise<ProtoWrapper> {
  const res = await playGet(url, defaultHeaders(auth), query);
  if (res.statusCode !== 200) {
    throw new Error(`finsky ${url}: HTTP ${res.statusCode} ${res.body.toString('utf8').slice(0, 200)}`);
  }
  return decodeProto<ProtoWrapper>('ResponseWrapper', res.body);
}

export interface FinskySearchOptions {
  /** Потолок страниц. 20 страниц * ~20 карточек ≈ 400 позиций. */
  maxPages?: number;
  /** Пауза между страницами, мс — Play не любит быстрый обход. */
  delayMs?: number;
}

/**
 * Ранжированный список приложений по ключу. Позиция приложения = его индекс+1.
 *
 * Берём самый крупный кластер первой страницы: кроме основной выдачи Play
 * подмешивает промо-кластеры («вам может понравиться», подборки), и если
 * считать позиции по ним — ранги поедут.
 */
export async function finskySearch(
  auth: AuthState,
  term: string,
  opts: FinskySearchOptions = {},
): Promise<FinskySearchResult> {
  const maxPages = opts.maxPages ?? 15;
  const delayMs = opts.delayMs ?? 400;

  const first = await fetchWrapper(auth, URL_SEARCH, { q: term, c: '3', ksm: '1' });
  const clusters = listResponseOf(first)?.item?.subItem ?? [];
  if (clusters.length === 0) {
    return { term, apps: [], pages: 1, clusterTitle: '', truncated: false };
  }

  let main = clusters[0]!;
  let mainCount = appsOf(main).length;
  for (const cluster of clusters.slice(1)) {
    const count = appsOf(cluster).length;
    if (count > mainCount) {
      main = cluster;
      mainCount = count;
    }
  }

  const apps: FinskyApp[] = [];
  const seen = new Set<string>();
  const push = (list: FinskyApp[]): void => {
    for (const app of list) {
      if (seen.has(app.packageName)) continue;
      seen.add(app.packageName);
      apps.push(app);
    }
  };

  push(appsOf(main));

  let nextPageUrl = main.containerMetadata?.nextPageUrl ?? '';
  let pages = 1;
  while (nextPageUrl && pages < maxPages) {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const wrapper = await fetchWrapper(auth, `${URL_FDFE}/${nextPageUrl}`);
    const cluster = listResponseOf(wrapper)?.item?.subItem?.[0];
    if (!cluster) break;
    const before = apps.length;
    push(appsOf(cluster));
    pages++;
    nextPageUrl = cluster.containerMetadata?.nextPageUrl ?? '';
    // Страница без единой новой карточки = выдача кончилась, дальше цикл.
    if (apps.length === before) break;
  }

  return {
    term,
    apps,
    pages,
    clusterTitle: main.title ?? '',
    truncated: Boolean(nextPageUrl) && pages >= maxPages,
  };
}

/** Позиция приложения по ключу. null = вне пройденной глубины выдачи. */
export async function finskyGetRank(
  auth: AuthState,
  packageName: string,
  term: string,
  opts: FinskySearchOptions = {},
): Promise<{ rank: number | null; total: number; truncated: boolean }> {
  const result = await finskySearch(auth, term, opts);
  const idx = result.apps.findIndex((a) => a.packageName === packageName);
  return {
    rank: idx === -1 ? null : idx + 1,
    total: result.apps.length,
    truncated: result.truncated,
  };
}
