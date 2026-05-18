import { nativeSearchIds } from '../scrapers/native.js';
import { estimateVolume } from '../analytics/volume.js';
import { estimateDifficulty } from '../analytics/difficulty.js';
import { gpSearch } from '../scrapers/googleplay.js';
import { gpEstimateVolume, gpEstimateDifficulty } from '../analytics/gp.js';
import { distinctMetricTargets, saveMetricCheck } from '../db/repo.js';

/**
 * Переснимает все связки «приложение + ключ», которые уже проверялись,
 * и сохраняет новый замер в историю — для накопления графиков.
 */
export async function recheckAll(): Promise<number> {
  const targets = await distinctMetricTargets();
  console.log(`[recheck] старт: ${targets.length} связок`, new Date().toISOString());
  let saved = 0;

  for (const t of targets) {
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
          estimateVolume(t.term, t.country),
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
    } catch (err) {
      console.error(`[recheck] ${t.platform}/${t.appId}/${t.term}:`, String(err));
    }
  }

  console.log(`[recheck] готово: сохранено ${saved}/${targets.length}`);
  return saved;
}
