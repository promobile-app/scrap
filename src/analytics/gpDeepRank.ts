import { gpRpcSearch } from '../scrapers/gplayRpc.js';
import { langOf } from '../scrapers/googleplay.js';

// Гибрид глубины для Android-discovery: основная масса кандидатов меряется
// дешёвым одностраничным gpSearch (~20-30 позиций), и только ключи, где
// приложение не нашлось на первой странице, добиваются batchexecute-RPC
// витрины (~16 позиций на страницу, пауза 300мс между страницами). RPC на
// каждый кандидат — до maxPages запросов, поэтому и число ключей, и глубина
// ограничены отдельно от основного потолка кандидатов.
// Полный бюджет — для фоновых discovery-job'ов (расширение), где время не
// критично. Синхронный бюджет — для дашбордного /apps/:id/discover, который
// держит открытый HTTP-запрос: полный дозамер (30×10 страниц с паузами)
// добавлял ~100с и ответ переставал влезать в таймауты цепочки клиент→бекенд.
const RPC_RECHECK_LIMIT = Number(process.env.DISCOVERY_RPC_RECHECK ?? 30);
const RPC_RECHECK_PAGES = Number(process.env.DISCOVERY_RPC_RECHECK_PAGES ?? 10);
const RPC_SYNC_LIMIT = Number(process.env.DISCOVERY_RPC_RECHECK_SYNC ?? 10);
const RPC_SYNC_PAGES = Number(process.env.DISCOVERY_RPC_RECHECK_PAGES_SYNC ?? 5);
// Конкурентность ниже, чем у HTML-замеров: у RPC уже есть межстраничная
// пауза, а параллельные обходы страниц умножают шанс капчи.
const RPC_CONCURRENCY = 2;

export type RecheckBudget = 'job' | 'sync';

export interface DeepRankResult {
  rank: number | null;
  totalResults: number;
  ids: string[];
}

function limitsFor(budget: RecheckBudget): { limit: number; pages: number } {
  return budget === 'sync'
    ? { limit: RPC_SYNC_LIMIT, pages: RPC_SYNC_PAGES }
    : { limit: RPC_RECHECK_LIMIT, pages: RPC_RECHECK_PAGES };
}

/** Доступен ли глубокий дозамер вообще (лимиты можно занулить через env). */
export function deepRecheckEnabled(budget: RecheckBudget = 'job'): boolean {
  const { limit, pages } = limitsFor(budget);
  return limit > 0 && pages > 0;
}

/** Обрезает список кандидатов на дозамер до лимита RPC-бюджета. */
export function capRecheckTerms(terms: string[], budget: RecheckBudget = 'job'): string[] {
  return terms.slice(0, limitsFor(budget).limit);
}

/**
 * Глубокие ранки по списку ключей через RPC витрины Play. Возвращает только
 * успешно замеренные термы; упавший/пустой RPC-ответ по ключу молча
 * пропускается — у вызывающего остаётся результат дешёвого замера.
 */
export async function gpDeepRanks(
  appId: string,
  country: string,
  terms: string[],
  budget: RecheckBudget = 'job',
): Promise<Map<string, DeepRankResult>> {
  const out = new Map<string, DeepRankResult>();
  if (!deepRecheckEnabled(budget) || terms.length === 0) return out;

  const queue = [...terms];
  const language = langOf(country);
  const { pages } = limitsFor(budget);
  const worker = async (): Promise<void> => {
    for (let term = queue.shift(); term !== undefined; term = queue.shift()) {
      try {
        const res = await gpRpcSearch(term, country, {
          language,
          maxPages: pages,
        });
        if (res.packageNames.length === 0) continue; // блокировка/пустой ответ — не перетираем дешёвый замер
        const idx = res.packageNames.indexOf(appId);
        out.set(term, {
          rank: idx === -1 ? null : idx + 1,
          totalResults: res.packageNames.length,
          ids: res.packageNames,
        });
      } catch {
        // RPC недоступен по этому ключу — остаётся результат gpSearch.
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(RPC_CONCURRENCY, terms.length) }, () => worker()),
  );
  return out;
}
