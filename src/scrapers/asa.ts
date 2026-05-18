import { config } from '../config.js';

/**
 * Заглушка интеграции Apple Search Ads API.
 *
 * Метрика popularity (точный поисковый объём, шкала 5-100) доступна через
 * Apple Search Ads Campaign Management API, эндпоинт:
 *   POST /api/v5/keywords/searchvolume  (или suggestions с метрикой)
 * Требует:
 *   - аккаунт Apple Search Ads
 *   - OAuth2 client credentials (ASA_CLIENT_ID, ASA_TEAM_ID, ASA_KEY_ID)
 *   - приватный ключ ES256 для подписи JWT
 *
 * Шаги после получения аккаунта:
 *   1. Сгенерировать пару ключей и загрузить публичный в кабинет ASA.
 *   2. Заполнить ASA_* в .env.
 *   3. Реализовать getAccessToken() — обмен подписанного JWT на токен.
 *   4. Реализовать searchVolume(terms) — запрос метрики popularity.
 *   5. В коллекторе volume использовать этот источник вместо estimateVolume.
 */
export function isAsaConfigured(): boolean {
  return Boolean(config.asa.clientId && config.asa.teamId && config.asa.keyId);
}

export async function searchVolumeASA(_terms: string[]): Promise<never> {
  throw new Error(
    'Apple Search Ads ещё не подключён. Заполните ASA_* в .env и реализуйте asa.ts.',
  );
}
