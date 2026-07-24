import 'dotenv/config';
import { buildAuth } from './auth.js';
import { finskySearch } from './search.js';

/**
 * Пробник глубины выдачи Google Play через Finsky.
 *
 * Отвечает на единственный вопрос: сколько позиций реально отдаёт мобильный
 * API против ~20-30 у веб-парсера. Ничего не пишет в БД и не трогает
 * платные эндпоинты.
 *
 *   FINSKY_EMAIL=... FINSKY_AAS_TOKEN=... \
 *     npx tsx src/scrapers/finsky/probe.ts "roblox" ru_RU com.roblox.client 15
 *
 * Аргументы: term [locale] [packageName] [maxPages]
 */

const term = process.argv[2];
const locale = process.argv[3] ?? process.env.FINSKY_LOCALE ?? 'en_US';
const packageName = process.argv[4] ?? '';
const maxPages = Number(process.argv[5] ?? 15);

if (!term) {
  console.error(
    'Использование: npx tsx src/scrapers/finsky/probe.ts "<term>" [locale] [packageName] [maxPages]',
  );
  process.exit(1);
}

(async () => {
  console.error(`Авторизация (locale=${locale})…`);
  const auth = await buildAuth({ locale });
  console.error(`gsfId=${auth.gsfId} device=${auth.device.name}`);

  console.error(`Ищу "${term}", максимум ${maxPages} страниц…`);
  const started = Date.now();
  const result = await finskySearch(auth, term, { maxPages });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`\nКластер: "${result.clusterTitle}"`);
  console.log(`Страниц пройдено: ${result.pages}${result.truncated ? ' (упёрлись в maxPages)' : ''}`);
  console.log(`ГЛУБИНА ВЫДАЧИ: ${result.apps.length} приложений за ${seconds}с`);
  console.log(`Для сравнения: веб-парсер отдаёт 19-30.\n`);

  console.log('Топ-10:');
  for (const [i, app] of result.apps.slice(0, 10).entries()) {
    const installs = app.installsLabel || (app.installs ? String(app.installs) : '—');
    console.log(
      `  ${String(i + 1).padStart(3)}. ${app.packageName.padEnd(40)} ${installs.padStart(8)}  ${app.title}`,
    );
  }

  if (packageName) {
    const idx = result.apps.findIndex((a) => a.packageName === packageName);
    console.log(
      `\n${packageName}: ${idx === -1 ? `не найден в первых ${result.apps.length}` : `позиция ${idx + 1}`}`,
    );
  }

  // Хвост выдачи — доказательство, что позиции глубже 30 действительно приходят.
  if (result.apps.length > 30) {
    console.log('\nХвост (позиции 30+):');
    for (const [i, app] of result.apps.slice(29, 40).entries()) {
      console.log(`  ${String(i + 30).padStart(3)}. ${app.packageName}`);
    }
  }
})().catch((e: unknown) => {
  console.error('❌', e instanceof Error ? e.message : e);
  process.exit(1);
});
