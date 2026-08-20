import { nativeSearchIds } from '../scrapers/native.js';
import { getVolume } from '../analytics/appstore/volume.js';
import { estimateDifficulty } from '../analytics/appstore/difficulty.js';
import { gpSearch } from '../scrapers/googleplay.js';
import { gpEstimateVolume } from '../analytics/googleplay/volume.js';
import { gpEstimateDifficulty } from '../analytics/googleplay/difficulty.js';
import { distinctMetricTargets, saveMetricCheck } from '../db/repo.js';
import { poolExhausted, proxyAddressStats } from '../scrapers/proxy.js';
import { trackedRecheckTargets } from '../tracking/tracking.js';

/**
 * Сколько связок пересчитывается одновременно.
 *
 * Проход был строго последовательным: связка за связкой, ~секунда на каждую,
 * 44 тысячи связок — двенадцать часов. Отсюда и наблюдаемый ритм «обновилось в
 * 4 и в 16»: это не расписание, а длительность прохода.
 *
 * Темп запросов к магазину этим НЕ задаётся — его держит пул каналов в
 * native.ts (APPLE_CHANNELS × APPLE_NATIVE_DELAY_MS). Здесь только глубина
 * очереди: воркеры упрутся в паузы каналов и будут ждать, а не разгонят
 * нагрузку сверх того, что пул готов выпустить. Поэтому значение можно
 * держать выше, чем кажется безопасным: потолок всё равно не здесь.
 */
const CONCURRENCY = Number(process.env.RECHECK_CONCURRENCY ?? 8);

/**
 * Выработка адресов за проход — в лог планировщика, а не в /health/apple.
 *
 * Ручка отдаёт счётчики API-процесса, а квоту Apple выжигает проход, и это
 * отдельный процесс со своей памятью (см. `start` в package.json: server.js и
 * scheduler.js запускаются рядом). Разрез, ради которого счётчик заводился,
 * достать можно только отсюда.
 *
 * Строки отсортированы по подсети, чтобы соседи по /24 стояли рядом: если их
 * before403 близки и first приходится на одну минуту, квота считается на
 * подсеть, и докупать адреса в тех же блоках бесполезно.
 */
function logAddressReport(): void {
  const rows = proxyAddressStats('apple');
  if (!rows.length) return;
  const at = (iso: string | null): string => (iso ? iso.slice(11, 19) : '—');
  console.log(
    '[proxy] выработка за проход — ok: успешных ответов, before403: успело до' +
    ' первого отказа, fails: отказов, first/last: время первого и последнего (UTC)',
  );
  const sorted = [...rows].sort(
    (a, b) => (a.group ?? 0) - (b.group ?? 0) || a.slot - b.slot,
  );
  for (const r of sorted) {
    console.log(
      `[proxy] slot=${String(r.slot).padStart(2)} /24=${String(r.group ?? '?').padStart(2)}` +
      ` ok=${String(r.ok).padStart(5)} before403=${r.okBeforeFirstFail ?? '—'}` +
      ` fails=${r.throttled} first=${at(r.firstFailAt)} last=${at(r.lastFailAt)}`,
    );
  }
}

type RecheckTarget = Awaited<ReturnType<typeof distinctMetricTargets>>[number];

/** Один пересчёт: замер по обеим платформам и запись в историю. */
async function recheckTarget(t: RecheckTarget): Promise<void> {
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
    return;
  }

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
  console.log(
    `[recheck] старт: ${targets.length} связок в ${CONCURRENCY} потоков`,
    new Date().toISOString(),
  );
  let saved = 0;
  // Провалы подряд означают, что закрыт источник, а не что не повезло с
  // конкретным ключом. Дальше идти незачем: 20 августа прогон перемолол
  // 36 тысяч связок по три попытки каждая, ничего не сохранил и всё это время
  // держал квоту Apple на нуле, не давая адресам отлежаться.
  const streakLimit = Number(process.env.RECHECK_FAILURE_STREAK ?? 25);
  let streak = 0;
  let cursor = 0;
  let stopped = false;

  const worker = async (): Promise<void> => {
    while (!stopped) {
      const i = cursor++;
      if (i >= targets.length) return;
      const t = targets[i]!;
      try {
        await recheckTarget(t);
        saved++;
        // Успех обнуляет счётчик: пул, отдающий хоть что-то, ещё жив.
        streak = 0;
      } catch (err) {
        streak++;
        console.error(`[recheck] ${t.platform}/${t.appId}/${t.term}:`, String(err));
        if (streak >= streakLimit) {
          stopped = true;
          console.error(
            `[recheck] остановлен: ${streak} провалов подряд` +
            `${poolExhausted('apple') ? ' (пул прокси выбит целиком)' : ''}` +
            ` — пропущено ${Math.max(0, targets.length - cursor)} связок из ${targets.length}`,
          );
        }
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, targets.length) }, () => worker()),
  );

  console.log(`[recheck] готово: сохранено ${saved}/${targets.length}`);
  logAddressReport();
  return saved;
}
