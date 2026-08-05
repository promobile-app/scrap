import { gpRpcSearch } from '../scrapers/gplayRpc.js';
import { langOf } from '../scrapers/googleplay.js';

// Гибрид глубины для Android-discovery: основная масса кандидатов меряется
// дешёвым одностраничным gpSearch (~20-30 позиций), и только ключи, где
// приложение не нашлось на первой странице, добиваются batchexecute-RPC
// витрины (~16 позиций на страницу, пауза 300мс между страницами). RPC на
// каждый кандидат — до maxPages запросов, поэтому и число ключей, и глубина
// ограничены отдельно от основного потолка кандидатов.
const RPC_RECHECK_LIMIT = Number(process.env.DISCOVERY_RPC_RECHECK ?? 30);
const RPC_RECHECK_PAGES = Number(process.env.DISCOVERY_RPC_RECHECK_PAGES ?? 10);
// Конкурентность ниже, чем у HTML-замеров: у RPC уже есть межстраничная
// пауза, а параллельные обходы страниц умножают шанс капчи.
const RPC_CONCURRENCY = 2;

export interface DeepRankResult {
  rank: number | null;
  totalResults: number;
  ids: string[];
}

/** Доступен ли глубокий дозамер вообще (лимит можно занулить через env). */
export function deepRecheckEnabled(): boolean {
  return RPC_RECHECK_LIMIT > 0 && RPC_RECHECK_PAGES > 0;
}

/** Обрезает список кандидатов на дозамер до лимита RPC-бюджета. */
export function capRecheckTerms(terms: string[]): string[] {
  return terms.slice(0, RPC_RECHECK_LIMIT);
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
): Promise<Map<string, DeepRankResult>> {
  const out = new Map<string, DeepRankResult>();
  if (!deepRecheckEnabled() || terms.length === 0) return out;

  const queue = [...terms];
  const language = langOf(country);
  const worker = async (): Promise<void> => {
    for (let term = queue.shift(); term !== undefined; term = queue.shift()) {
      try {
        const res = await gpRpcSearch(term, country, {
          language,
          maxPages: RPC_RECHECK_PAGES,
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
