import { getRank } from '../scrapers/appstore.js';
import { topChart } from '../scrapers/charts.js';
import { getVolume } from '../analytics/appstore/volume.js';
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

/**
 * Сбор позиций отслеживаемых приложений в топ-чартах.
 *
 * Снимаем два среза на приложение: общий чарт витрины и чарт его категории —
 * именно эту пару показывает раздел Rankings в ASO-отчёте, и по категории
 * приложение почти всегда видно, даже когда в общем чарте его нет.
 *
 * Чарт тянется один раз на (страна, жанр), а не на каждое приложение: это одна
 * и та же сотня позиций, и без группировки сбор бил бы по Apple столько раз,
 * сколько у нас отслеживаемых приложений.
 *
 * Позиция NULL (вне топа) тоже пишется: без неё в графике вместо провала
 * получится разрыв, и «выпал из чарта» будет неотличим от «сбор не отработал».
 */
export async function collectCharts(country = 'us'): Promise<number> {
  const apps = await trackedApps();
  if (!apps.length) return 0;

  const genreSlots: (number | null)[] = [null];
  for (const a of apps) {
    if (a.genreId != null && !genreSlots.includes(a.genreId)) genreSlots.push(a.genreId);
  }

  let count = 0;
  for (const genreId of genreSlots) {
    let positionById: Map<number, number>;
    try {
      const chart = await topChart('top-free', country, genreId ?? undefined);
      positionById = new Map(chart.map((e) => [e.appId, e.position]));
    } catch (err) {
      console.error(`chart fetch ${country} genre=${genreId}:`, String(err));
      continue;
    }

    const relevant = genreId === null ? apps : apps.filter((a) => a.genreId === genreId);
    for (const a of relevant) {
      try {
        await saveChartSnapshot(
          a.appId,
          'top-free',
          country,
          genreId,
          positionById.get(a.appId) ?? null,
        );
        count++;
      } catch (err) {
        console.error(`chart save ${a.appId} genre=${genreId}:`, String(err));
      }
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
      const v = await getVolume(k.term, k.country);
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
