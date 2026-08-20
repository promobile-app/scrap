import { nativeSearchIds } from '../scrapers/native.js';
import { getVolume } from '../analytics/appstore/volume.js';
import { estimateDifficulty } from '../analytics/appstore/difficulty.js';
import { gpSearch } from '../scrapers/googleplay.js';
import { gpEstimateVolume } from '../analytics/googleplay/volume.js';
import { gpEstimateDifficulty } from '../analytics/googleplay/difficulty.js';
import { distinctMetricTargets, saveMetricCheck } from '../db/repo.js';
import { poolExhausted } from '../scrapers/proxy.js';
import { trackedRecheckTargets } from '../tracking/tracking.js';

/**
 * Переснимает все связки «приложение + ключ», которые уже проверялись,
 * и сохраняет новый замер в историю — для накопления графиков.
 * Отслеживаемые приложения (tracked_apps) добавляются в цели явно: их история
 * должна копиться, даже если по ним давно не было ручных проверок.
 */
export async function recheckAll(): Promise<number> {
  const [historic, tracked] = await Promise.all([
    distinctMetricTargets(),
    trackedRecheckTargets(),
  ]);
  const seen = new Set(historic.map((t) => `${t.platform}|${t.appId}|${t.term}|${t.country}`));
  const targets = [
    ...historic,
    ...tracked.filter((t) => !seen.has(`${t.platform}|${t.appId}|${t.term}|${t.country}`)),
  ];
  console.log(`[recheck] старт: ${targets.length} связок`, new Date().toISOString());
  let saved = 0;
  // Провалы подряд означают, что закрыт источник, а не что не повезло с
  // конкретным ключом. Дальше идти незачем: 20 августа прогон перемолол
  // 36 тысяч связок по три попытки каждая, ничего не сохранил и всё это время
  // держал квоту Apple на нуле, не давая адресам отлежаться.
  const streakLimit = Number(process.env.RECHECK_FAILURE_STREAK ?? 25);
  let streak = 0;

  for (const [i, t] of targets.entries()) {
    try {
      if (t.platform === 'android') {
        const [results, volume, difficulty] = await Promise.all([
          gpSearch(t.term, t.country, 250),
          gpEstimateVolume(t.term, t.country),
          gpEstimateDifficulty(t.term, t.country),
        ]);
        const idx = results.findIndex((a) => a.appId === t.appId);
        await saveMetricCheck({
          platform: 'android', appId: t.appId, appTitle: t.appTitle,
          term: t.term, country: t.country, language: null,
          rank: idx === -1 ? null : idx + 1, totalResults: results.length,
          volume: volume.score, difficulty: difficulty.score,
        });
      } else {
        const [ids, volume, difficulty] = await Promise.all([
          nativeSearchIds(t.term, t.country, t.language ?? undefined),
          getVolume(t.term, t.country),
          estimateDifficulty(t.term, t.country),
        ]);
        const idx = ids.indexOf(t.appId);
        await saveMetricCheck({
          platform: 'ios', appId: t.appId, appTitle: t.appTitle,
          term: t.term, country: t.country, language: t.language,
          rank: idx === -1 ? null : idx + 1, totalResults: ids.length,
          volume: volume.score, difficulty: difficulty.score,
        });
      }
      saved++;
      streak = 0;
    } catch (err) {
      streak++;
      console.error(`[recheck] ${t.platform}/${t.appId}/${t.term}:`, String(err));
      if (streak >= streakLimit) {
        console.error(
          `[recheck] остановлен: ${streak} провалов подряд` +
          `${poolExhausted('apple') ? ' (пул прокси выбит целиком)' : ''}` +
          ` — пропущено ${targets.length - i - 1} связок из ${targets.length}`,
        );
        break;
      }
    }
  }

  console.log(`[recheck] готово: сохранено ${saved}/${targets.length}`);
  return saved;
}
