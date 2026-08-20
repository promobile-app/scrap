import { recheckAll } from './recheck.js';
import { collectCharts } from './collect.js';
import { sendDigests } from './digest.js';
import { seedGeoCorpus } from '../analytics/corpusSeeder.js';
import { lastMetricCheckAt } from '../db/repo.js';
import { pool } from '../db/pool.js';

const RECHECK_MS = 3 * 60 * 60 * 1000; // каждые 3 часа

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
  // Прогон на старте — только если прошлый был давно. Безусловный проход
  // превращал каждый деплой в полный обход всех связок: вечером 19 августа
  // пять деплоев подряд дали пять таких проходов за четыре часа поверх уже
  // исчерпанной квоты Apple, и она не успевала восстановиться между ними.
  const sinceLast = await msSinceLastRecheck();
  if (sinceLast >= RECHECK_MS) {
    await cycle();
    setInterval(() => { void cycle(); }, RECHECK_MS);
  } else {
    const wait = RECHECK_MS - sinceLast;
    console.log(
      `[recheck] прогон на старте пропущен: прошлый ${Math.round(sinceLast / 60_000)} мин назад, ` +
      `следующий через ${Math.round(wait / 60_000)} мин`,
    );
    setTimeout(() => {
      void cycle();
      setInterval(() => { void cycle(); }, RECHECK_MS);
    }, wait);
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
