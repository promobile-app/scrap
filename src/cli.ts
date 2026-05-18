import { appLookup, searchApps } from './scrapers/appstore.js';
import { upsertApp, upsertKeyword, linkAppKeyword } from './db/repo.js';
import { collectAll } from './jobs/collect.js';
import { pool } from './db/pool.js';

/**
 * CLI управления отслеживанием.
 *   npm run scrape -- track-app <appId>
 *   npm run scrape -- track-keyword <appId> <term...>
 *   npm run scrape -- collect
 *   npm run scrape -- search <term...>
 */
async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case 'track-app': {
      const app = await appLookup(Number(args[0]));
      if (!app) throw new Error('Приложение не найдено');
      await upsertApp(app, true);
      console.log(`Отслеживаю: ${app.title} (${app.appId})`);
      break;
    }
    case 'track-keyword': {
      const appId = Number(args[0]);
      const term = args.slice(1).join(' ');
      const app = await appLookup(appId);
      if (!app) throw new Error('Приложение не найдено');
      await upsertApp(app, true);
      const kw = await upsertKeyword(term, 'us', true);
      await linkAppKeyword(appId, kw.id);
      console.log(`Ключ "${kw.term}" привязан к ${app.title}`);
      break;
    }
    case 'collect':
      await collectAll();
      break;
    case 'search': {
      const results = await searchApps(args.join(' '), 'us', 20);
      results.forEach((a, i) => console.log(`${i + 1}. ${a.title} — ${a.developer} (${a.appId})`));
      break;
    }
    default:
      console.log('Команды: track-app | track-keyword | collect | search');
  }
  await pool.end();
}

main().catch(async (err) => {
  console.error('Ошибка:', String(err));
  await pool.end();
  process.exit(1);
});
