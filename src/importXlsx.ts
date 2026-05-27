/**
 * Импортирует FoxData-выгрузку «Keywords Ranked» (один файл = одно приложение)
 * в нашу базу:
 *   1) пишет все ключи в постоянный словарь app_candidate_keywords,
 *      чтобы BFS не запускался при будущих анализах;
 *   2) создаёт готовую discovery_jobs (status=done) с метриками из файла —
 *      первый же пользователь увидит результат мгновенно.
 *
 * Запуск:
 *   npm run import-xlsx -- ./file.xlsx --app-id=544007664 --country=us
 *   npm run import-xlsx -- ./file.xlsx --app-id=com.foo.bar \
 *       --country=us --platform=android --app-title="My App"
 *
 * Колонки в файле (FoxData):
 *   Keyword   — обязательная
 *   Ranking   — позиция приложения по ключу (число; «-» / 0 / пусто = вне топа)
 *   Vol       — оценка объёма
 *   Diff      — сложность
 *   Results   — кол-во конкурентов в выдаче
 * Остальные колонки (Change, Corr, Chance, Inst, Top 5 Applications,
 * Tracking Status) игнорируются.
 */
import ExcelJS from 'exceljs';
import { pool, query } from './db/pool.js';
import { saveAppCandidateKeywords } from './db/repo.js';

interface FlagMap { [k: string]: string }
function parseFlags(argv: string[]): { file: string | null; flags: FlagMap } {
  const flags: FlagMap = {};
  let file: string | null = null;
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) flags[m[1]!] = m[2]!;
    else if (!a.startsWith('--') && !file) file = a;
  }
  return { file, flags };
}

const HEADER_SYNONYMS: Record<string, string[]> = {
  term: ['keyword', 'term', 'kw'],
  rank: ['ranking', 'rank', 'position', 'pos'],
  volume: ['vol', 'volume'],
  difficulty: ['diff', 'difficulty'],
  totalResults: ['results', 'totalresults', 'competitors', 'total results'],
};

function normHeader(h: string): string {
  return h.toLowerCase().trim().replace(/[\s_-]+/g, ' ');
}

function findColumn(headers: string[], field: keyof typeof HEADER_SYNONYMS): number {
  const syns = HEADER_SYNONYMS[field]!;
  for (let i = 0; i < headers.length; i++) {
    if (syns.includes(normHeader(headers[i] ?? ''))) return i;
  }
  return -1;
}

function toInt(v: unknown): number | null {
  if (v == null || v === '' || v === '-') return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

interface Kw {
  term: string;
  rank: number | null;
  volume: number;
  difficulty: number;
  totalResults: number;
}

async function importFile(filePath: string, flags: FlagMap): Promise<void> {
  const appId = flags['app-id'];
  const country = (flags.country || '').toLowerCase();
  if (!appId || !country) {
    throw new Error('Нужны флаги --app-id=... и --country=...');
  }
  const platform: 'ios' | 'android' = flags.platform === 'android'
    ? 'android'
    : flags.platform === 'ios'
      ? 'ios'
      : /^\d+$/.test(appId) ? 'ios' : 'android';
  const appTitle = flags['app-title'] || null;

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const sheet = wb.worksheets[0];
  if (!sheet) throw new Error('Файл не содержит листов');

  // Заголовки могут быть на 1-й или 2-й строке (FoxData иногда добавляет
  // pre-header строку c названием экспорта). Берём ту, где есть «Keyword».
  let headerRowIdx = 1;
  let headers: string[] = [];
  for (let r = 1; r <= Math.min(3, sheet.rowCount); r++) {
    const row = sheet.getRow(r);
    const test: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell) => test.push(String(cell.value ?? '')));
    if (test.some((h) => normHeader(h) === 'keyword' || normHeader(h) === 'term')) {
      headers = test;
      headerRowIdx = r;
      break;
    }
  }
  if (headers.length === 0) {
    throw new Error('Не нашёл строку заголовков с колонкой Keyword');
  }

  const col = {
    term: findColumn(headers, 'term'),
    rank: findColumn(headers, 'rank'),
    volume: findColumn(headers, 'volume'),
    difficulty: findColumn(headers, 'difficulty'),
    totalResults: findColumn(headers, 'totalResults'),
  };
  if (col.term === -1) {
    throw new Error(`Не нашёл колонку Keyword. Headers: ${headers.join(' | ')}`);
  }

  const keywords: Kw[] = [];
  for (let r = headerRowIdx + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const cell = (c: number) => (c >= 0 ? row.getCell(c + 1).value : null);
    const term = String(cell(col.term) ?? '').trim().toLowerCase();
    if (!term) continue;
    const rank = toInt(cell(col.rank));
    keywords.push({
      term,
      rank: rank && rank > 0 ? rank : null,
      volume: toInt(cell(col.volume)) ?? 0,
      difficulty: toInt(cell(col.difficulty)) ?? 0,
      totalResults: toInt(cell(col.totalResults)) ?? 0,
    });
  }

  if (keywords.length === 0) throw new Error('Не нашёл ни одного ключа в файле');

  console.log(`Файл: ${filePath}`);
  console.log(`Приложение: ${platform} ${appId} (${country.toUpperCase()})`);
  console.log(`Ключей в файле: ${keywords.length}`);
  const ranked = keywords.filter((k) => k.rank != null);
  console.log(`  с позицией: ${ranked.length}, top-3: ${ranked.filter((k) => k.rank! <= 3).length}, top-10: ${ranked.filter((k) => k.rank! <= 10).length}`);

  // 1) Постоянный словарь — чтобы BFS не запускался.
  await saveAppCandidateKeywords(platform, appId, country, keywords.map((k) => k.term));

  // 2) Готовая discovery_jobs (status=done) — мгновенный ответ extension.
  // Если запись на (platform, app, country) уже есть и она «done», лучше
  // обновить её, а не плодить дубликаты.
  const jobKey = `${platform}|${appId}|${country}`;
  const existing = await query<{ id: number }>(
    `SELECT id FROM discovery_jobs WHERE job_key = $1
     ORDER BY created_at DESC LIMIT 1`,
    [jobKey],
  );
  const keywordsJson = JSON.stringify(keywords);
  if (existing[0]) {
    await query(
      `UPDATE discovery_jobs
       SET status = 'done', processed = $1, total = $1,
           keywords = $2::jsonb, app_title = COALESCE($3, app_title),
           updated_at = now(), error = NULL
       WHERE id = $4`,
      [keywords.length, keywordsJson, appTitle, existing[0].id],
    );
    console.log(`Обновлена discovery_jobs #${existing[0].id}`);
  } else {
    const inserted = await query<{ id: number }>(
      `INSERT INTO discovery_jobs
         (job_key, platform, app_id, country, status, total, processed, keywords, app_title)
       VALUES ($1, $2, $3, $4, 'done', $5, $5, $6::jsonb, $7)
       RETURNING id`,
      [jobKey, platform, appId, country, keywords.length, keywordsJson, appTitle],
    );
    console.log(`Создана discovery_jobs #${inserted[0]!.id}`);
  }
  console.log('Готово.');
}

const { file, flags } = parseFlags(process.argv.slice(2));
if (!file) {
  console.error('Использование: npm run import-xlsx -- ./file.xlsx --app-id=... --country=us [--platform=ios|android] [--app-title="..."]');
  process.exit(1);
}

importFile(file, flags)
  .then(() => pool.end())
  .catch((err) => {
    console.error('Ошибка импорта:', err.message || err);
    pool.end();
    process.exit(1);
  });
