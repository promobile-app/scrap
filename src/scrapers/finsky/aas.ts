import 'dotenv/config';
import { exchangeOAuthForAas } from './auth.js';

/**
 * Обмен одноразового oauth_token на долгоживущий aas_token.
 *
 *   npx tsx src/scrapers/finsky/aas.ts <email> <oauth_token>
 *
 * Где взять oauth_token — см. README.md рядом. Логин делает человек, этот
 * скрипт только меняет уже полученный токен. Токен одноразовый: если скрипт
 * ответил ошибкой, логиниться нужно заново.
 */

const email = process.argv[2];
const oauthToken = process.argv[3];

if (!email || !oauthToken) {
  console.error('Использование: npx tsx src/scrapers/finsky/aas.ts <email> <oauth_token>');
  process.exit(1);
}

exchangeOAuthForAas(email, oauthToken)
  .then(({ token, field, keys }) => {
    // Диагностика формата ответа: какие поля вернул Google и что мы взяли.
    // Значения не печатаем — это секреты.
    console.log(`\nполя ответа /auth: ${keys.join(', ')}`);
    console.log(`взято поле: ${field}, префикс значения: ${token.slice(0, 8)}…\n`);
    console.log('aas_token получен. Положи в окружение:\n');
    console.log(`FINSKY_EMAIL=${email}`);
    console.log(`FINSKY_AAS_TOKEN=${token}\n`);
    console.log('Это секрет: он даёт доступ к аккаунту Google. Не коммить.');
  })
  .catch((e: unknown) => {
    console.error('❌', e instanceof Error ? e.message : e);
    process.exit(1);
  });
