import { getRank } from '../scrapers/appstore.js';
import { getChartPosition } from '../scrapers/charts.js';
import { estimateVolume } from '../analytics/appstore/volume.js';
import {
  trackedAppKeywords,
  trackedApps,
  trackedKeywords,
  saveRankSnapshot,
  saveChartSnapshot,
  saveVolumeEstimate,
} from '../db/repo.js';

/** Сбор позиций отслеживаемых приложений по их ключевым словам. */
export async function collectRanks(): Promise<number> {
  const pairs = await trackedAppKeywords();
  let count = 0;
  for (const p of pairs) {
    try {
      const { rank, total } = await getRank(p.appId, p.term, p.country);
      await saveRankSnapshot(p.appId, p.keywordId, rank, total);
      count++;
    } catch (err) {
      console.error(`rank ${p.appId}/${p.term}:`, String(err));
    }
  }
  return count;
}

/** Сбор позиций отслеживаемых приложений в топ-чартах. */
export async function collectCharts(country = 'us'): Promise<number> {
  const apps = await trackedApps();
  let count = 0;
  for (const a of apps) {
    try {
      const pos = await getChartPosition(a.appId, 'top-free', country);
      await saveChartSnapshot(a.appId, 'top-free', country, null, pos);
      count++;
    } catch (err) {
      console.error(`chart ${a.appId}:`, String(err));
    }
  }
  return count;
}

/** Обновление оценок поискового объёма для отслеживаемых ключей. */
export async function collectVolumes(): Promise<number> {
  const keywords = await trackedKeywords();
  let count = 0;
  for (const k of keywords) {
    try {
      const v = await estimateVolume(k.term, k.country);
      await saveVolumeEstimate(k.id, v.score, v.source, v.totalResults);
      count++;
    } catch (err) {
      console.error(`volume ${k.term}:`, String(err));
    }
  }
  return count;
}

/** Полный ежедневный прогон сбора. */
export async function collectAll(): Promise<void> {
  console.log('[collect] старт', new Date().toISOString());
  const ranks = await collectRanks();
  const charts = await collectCharts();
  const volumes = await collectVolumes();
  console.log(`[collect] готово: ranks=${ranks} charts=${charts} volumes=${volumes}`);
}
