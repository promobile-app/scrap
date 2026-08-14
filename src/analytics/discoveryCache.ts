import {
  discoverKeywords, discoverKeywordsGp,
  type DiscoveredKeyword, type DiscoveryResult,
} from './discovery.js';
import { getDiscoverySnapshot, saveDiscoverySnapshot } from '../db/repo.js';

/**
 * Снимок подбора + фоновое обновление.
 *
 * Полный подбор — это десятки секунд запросов к магазину, и раньше клиент
 * ждал их синхронно на каждый клик по «Индексации». Здесь запрос всегда
 * отвечает тем, что уже есть, а пересчёт уходит в фон:
 *   нет снимка        -> считаем и ждём (первый раз ждать нечего);
 *   снимок свежий     -> отдаём как есть;
 *   снимок устарел    -> отдаём старый + refreshing: true, считаем в фоне.
 *
 * Это же снимает и параллельный перерасчёт: на пару (приложение, гео) в любой
 * момент крутится максимум один подбор, остальные запросы переиспользуют его.
 */

export interface CachedDiscoveryResult extends DiscoveryResult {
  /** Когда снимок был посчитан. null — если считается прямо сейчас впервые. */
  updatedAt: string | null;
  /** Идёт ли фоновый пересчёт: клиенту стоит переспросить чуть позже. */
  refreshing: boolean;
}

const SNAPSHOT_TTL_MS = Number(
  process.env.DISCOVERY_SNAPSHOT_TTL_MS ?? 6 * 60 * 60 * 1000,
);

const inFlight = new Map<string, Promise<DiscoveryResult>>();

// Сколько подборов считаем одновременно. Дедупликация по (приложение, гео)
// не спасает от параллельных задач по РАЗНЫМ приложениям: каждая внутри себя
// держит до DISCOVERY_CONCURRENCY_IOS запросов, и три-четыре одновременных
// подбора уже перекрывают пропускную способность пула каналов — магазин
// начинает отвечать 429 всем, включая обычные замеры метрик.
const MAX_CONCURRENT = Number(process.env.DISCOVERY_MAX_CONCURRENT_JOBS ?? 3);
let active = 0;
const waiting: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => waiting.push(resolve));
}

function releaseSlot(): void {
  const next = waiting.shift();
  if (next) next();
  else active--;
}

async function runDiscovery(
  platform: 'ios' | 'android', appId: string, country: string, language?: string,
): Promise<DiscoveryResult> {
  await acquireSlot();
  let res: DiscoveryResult;
  try {
    res = platform === 'android'
      ? await discoverKeywordsGp(appId, country)
      : await discoverKeywords(Number(appId), country, language);
  } finally {
    releaseSlot();
  }
  try {
    await saveDiscoverySnapshot(platform, appId, country, res.title, res.keywords);
  } catch {
    // БД недоступна — снимок не сохранится, но ответ уже посчитан.
  }
  return res;
}

/**
 * Запускает подбор или возвращает уже идущий по этой паре.
 *
 * Ключ — без языка: ранжирование в App Store зависит от витрины, а не от
 * языка витрины (замер: ответы на `143443,29` и `143443-2,29` совпадают),
 * поэтому снимок для de/de и de/en это один и тот же список.
 */
function startDiscovery(
  platform: 'ios' | 'android', appId: string, country: string, language?: string,
): Promise<DiscoveryResult> {
  const key = `${platform}|${appId}|${country}`;
  const running = inFlight.get(key);
  if (running) return running;

  const job = runDiscovery(platform, appId, country, language)
    .finally(() => inFlight.delete(key));
  inFlight.set(key, job);
  return job;
}

export async function discoverKeywordsCached(
  platform: 'ios' | 'android',
  appId: string,
  country: string,
  opts: { wait?: boolean; language?: string } = {},
): Promise<CachedDiscoveryResult> {
  const snapshot = await getDiscoverySnapshot<DiscoveredKeyword>(
    platform, appId, country,
  ).catch(() => null);

  const capturedAt = snapshot ? new Date(snapshot.capturedAt) : null;
  const isFresh = capturedAt
    ? Date.now() - capturedAt.getTime() < SNAPSHOT_TTL_MS
    : false;

  if (snapshot && isFresh && !opts.wait) {
    return {
      appId, title: snapshot.appTitle, country,
      keywords: snapshot.keywords,
      updatedAt: capturedAt!.toISOString(),
      refreshing: inFlight.has(`${platform}|${appId}|${country}`),
    };
  }

  const job = startDiscovery(platform, appId, country, opts.language);

  // Ждать приходится только когда отдавать нечего (или попросили явно).
  if (!snapshot || opts.wait) {
    const res = await job;
    return { ...res, updatedAt: new Date().toISOString(), refreshing: false };
  }

  // Снимок устарел: отдаём его немедленно, пересчёт идёт в фоне. Ошибку
  // фоновой задачи гасим здесь — иначе она всплывёт как unhandled rejection.
  job.catch(() => {});
  return {
    appId, title: snapshot.appTitle, country,
    keywords: snapshot.keywords,
    updatedAt: capturedAt!.toISOString(),
    refreshing: true,
  };
}
