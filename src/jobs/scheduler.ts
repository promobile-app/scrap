import { recheckAll } from './recheck.js';
import { collectCharts } from './collect.js';
import { sendDigests } from './digest.js';
import { seedGeoCorpus } from '../analytics/corpusSeeder.js';
import { lastMetricCheckAt } from '../db/repo.js';
import { pool } from '../db/pool.js';

/**
 * Часы, в которые запускается пересчёт, по локальному времени контейнера.
 *
 * Раньше расписания не было вовсе: таймер отсчитывал от старта процесса, а
 * проход длился двенадцать часов, поэтому «обновилось в 4 и в 16» получалось
 * само собой и съезжало от каждого деплоя. Теперь проход укладывается в пару
 * часов, и эти часы надо задать явно, иначе ритм определяет момент последней
 * выкатки.
 *
 * Часовой пояс берётся из TZ (на Railway по умолчанию UTC) — то есть чтобы
 * «4 и 16» означали киевское время, TZ должен быть Europe/Kyiv.
 */
const RUN_AT_HOURS = (process.env.RECHECK_AT_HOURS ?? '4,16')
  .split(',')
  .map((h) => Number(h.trim()))
  .filter((h) => Number.isInteger(h) && h >= 0 && h < 24)
  .sort((a, b) => a - b);

/** Столько же держим как «давно не считали» для догоняющего прогона. */
const RECHECK_MS = Number(process.env.RECHECK_INTERVAL_MS ?? 12 * 60 * 60 * 1000);

/** Миллисекунды до ближайшего запуска по расписанию. */
function msUntilNextRun(from = new Date()): number {
  if (!RUN_AT_HOURS.length) return RECHECK_MS;
  for (let day = 0; day < 2; day++) {
    for (const hour of RUN_AT_HOURS) {
      const at = new Date(from);
      at.setDate(at.getDate() + day);
      at.setHours(hour, 0, 0, 0);
      if (at.getTime() > from.getTime()) return at.getTime() - from.getTime();
    }
  }
  return RECHECK_MS;
}

/** Запуск по расписанию: отработали — тут же встали в очередь на следующий час. */
function scheduleRuns(): void {
  const wait = msUntilNextRun();
  const at = new Date(Date.now() + wait);
  console.log(
    `[recheck] следующий проход в ${at.toLocaleTimeString()} ` +
    `(через ${Math.round(wait / 60_000)} мин; расписание ${RUN_AT_HOURS.join(', ')})`,
  );
  setTimeout(() => {
    void cycle().finally(() => scheduleRuns());
  }, wait).unref();
}

// Снимки позиций в топ-чартах. Витрины задаются списком: чарт — это страна,
// и снимать его «для всех» бессмысленно, нужны те гео, по которым смотрят
// отчёты. Пустой список = сбор выключен.
const CHART_COUNTRIES = (process.env.CHART_COUNTRIES ?? '')
  .split(',')
  .map((c) => c.trim().toLowerCase())
  .filter(Boolean);
// Чарты Apple пересчитываются раз в сутки, чаще снимать нечего.
const CHART_INTERVAL_MS = Number(process.env.CHART_INTERVAL_MS ?? 12 * 60 * 60 * 1000);

// Затравка словаря по витринам. Пустой список = выключено: задача надолго
// занимает пул каналов, и включать её надо осознанно, под конкретные гео.
const SEED_COUNTRIES = (process.env.CORPUS_SEED_COUNTRIES ?? '')
  .split(',')
  .map((c) => c.trim().toLowerCase())
  .filter(Boolean);
const SEED_INTERVAL_MS = Number(process.env.CORPUS_SEED_INTERVAL_MS ?? 6 * 60 * 60 * 1000);
let seedCursor = 0;

/**
 * Планировщик автозамеров: переснимает все проверявшиеся связки
 * «приложение + ключ» сразу при старте и далее каждые 3 часа,
 * накапливая историю для графиков. После каждого прохода — email-дайджест
 * значимых изменений по отслеживаемым приложениям (не чаще раза в
 * digestMinHours на пользователя — троттлинг внутри sendDigests).
 */
async function cycle(): Promise<void> {
  await recheckAll().catch((e) => console.error('recheck failed:', e));
  await sendDigests().catch((e) => console.error('digest failed:', e));
}

/**
 * Затравка словаря — по одной витрине за тик, по кругу. Не пачкой: две
 * витрины одновременно поделят между собой ту же пропускную способность и
 * только добавят риск 429, а растянутый по времени обход даёт тот же охват.
 */
async function seedCycle(): Promise<void> {
  if (SEED_COUNTRIES.length === 0) return;
  const country = SEED_COUNTRIES[seedCursor % SEED_COUNTRIES.length]!;
  seedCursor++;
  await seedGeoCorpus(country).catch((e) => console.error('seed failed:', e));
}

/** Снимки позиций в чартах по каждой настроенной витрине. */
async function chartCycle(): Promise<void> {
  for (const country of CHART_COUNTRIES) {
    const saved = await collectCharts(country).catch((e) => {
      console.error(`charts ${country} failed:`, e);
      return 0;
    });
    console.log(`[charts] ${country}: сохранено снимков ${saved}`);
  }
}

/**
 * Сколько прошло с прошлого замера. Планировщик своего состояния не хранит,
 * но оно и не нужно: последний сохранённый замер и есть отметка о прогоне.
 */
async function msSinceLastRecheck(): Promise<number> {
  try {
    const at = await lastMetricCheckAt();
    return at ? Date.now() - at.getTime() : Number.POSITIVE_INFINITY;
  } catch {
    // БД недоступна — ведём себя как раньше, прогоном на старте.
    return Number.POSITIVE_INFINITY;
  }
}

async function main(): Promise<void> {
  // Догоняющий прогон на старте — только если данные успели протухнуть.
  // Безусловный проход превращал каждый деплой в полный обход всех связок:
  // вечером 19 августа пять деплоев подряд дали пять таких проходов за четыре
  // часа поверх уже исчерпанной квоты Apple.
  const sinceLast = await msSinceLastRecheck();
  if (sinceLast >= RECHECK_MS) {
    console.log(
      `[recheck] догоняющий прогон: прошлый замер ${Math.round(sinceLast / 3_600_000)} ч назад`,
    );
    void cycle().finally(() => scheduleRuns());
  } else {
    console.log(
      `[recheck] прогон на старте пропущен: прошлый ${Math.round(sinceLast / 60_000)} мин назад`,
    );
    scheduleRuns();
  }

  if (CHART_COUNTRIES.length) {
    console.log(
      `[charts] расписание: ${CHART_COUNTRIES.join(', ')} — каждые ` +
      `${Math.round(CHART_INTERVAL_MS / 60000)} мин`,
    );
    void chartCycle();
    setInterval(() => { void chartCycle(); }, CHART_INTERVAL_MS);
  }

  if (SEED_COUNTRIES.length) {
    console.log(
      `[seed] расписание: ${SEED_COUNTRIES.join(', ')} — по одной витрине каждые ` +
      `${Math.round(SEED_INTERVAL_MS / 60000)} мин`,
    );
    // Первый прогон — не на старте: при деплое сначала должен подняться и
    // прогреться основной трафик, а не тысячи фоновых запросов к магазину.
    setInterval(() => { void seedCycle(); }, SEED_INTERVAL_MS);
  }
}

main().catch(async (err) => {
  console.error('scheduler failed:', err);
  await pool.end();
  process.exit(1);
});
