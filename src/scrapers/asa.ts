import { readFileSync } from 'node:fs';
import jwt from 'jsonwebtoken';
import { request } from 'undici';
import { config } from '../config.js';

/**
 * Интеграция Apple Search Ads (Apple Ads) Campaign Management API.
 *
 * Поток авторизации (OAuth2 client credentials):
 *   1. Подписываем client-secret JWT (ES256) приватным ключом ASA_PRIVATE_KEY_PATH.
 *   2. Меняем его на access_token на https://appleid.apple.com/auth/oauth2/token.
 *   3. Узнаём orgId через /api/v5/acls и шлём его в заголовке X-AP-Context.
 *
 * Метрика popularity (поисковый объём, шкала ~5-100, как у FoxData) — отдаётся
 * keyword-popularity эндпоинтом дашборда. Точный путь/форму подбираем живым
 * запросом (см. searchVolumeASA) — ядро (токен + orgId) от этого не зависит.
 */

const APPLE_ID_TOKEN_URL = 'https://appleid.apple.com/auth/oauth2/token';
const ASA_API_BASE = 'https://api.searchads.apple.com/api/v5';

export function isAsaConfigured(): boolean {
  return Boolean(
    config.asa.clientId && config.asa.teamId && config.asa.keyId && config.asa.privateKeyPath,
  );
}

let privateKeyCache: string | null = null;
function loadPrivateKey(): string {
  if (privateKeyCache) return privateKeyCache;
  if (!config.asa.privateKeyPath) {
    throw new Error('ASA_PRIVATE_KEY_PATH не задан в .env');
  }
  privateKeyCache = readFileSync(config.asa.privateKeyPath, 'utf8');
  return privateKeyCache;
}

/**
 * Собирает подписанный client-secret JWT (ES256).
 * exp Apple ограничивает 180 днями; берём с запасом 150 дней.
 */
function buildClientSecret(): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      sub: config.asa.clientId,
      aud: 'https://appleid.apple.com',
      iss: config.asa.teamId,
      iat: now,
      exp: now + 150 * 24 * 60 * 60,
    },
    loadPrivateKey(),
    { algorithm: 'ES256', keyid: config.asa.keyId },
  );
}

// access_token живёт ~1 час; кэшируем с запасом по времени.
let tokenCache: { token: string; expiresAt: number } | null = null;

export async function getAccessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token;

  const body = new URLSearchParams({
    client_id: config.asa.clientId,
    client_secret: buildClientSecret(),
    grant_type: 'client_credentials',
    scope: 'searchadsorg',
  });

  const res = await request(APPLE_ID_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Host: 'appleid.apple.com',
    },
    body: body.toString(),
  });

  const text = await res.body.text();
  if (res.statusCode >= 400) {
    throw new Error(`ASA token error ${res.statusCode}: ${text}`);
  }
  const json = JSON.parse(text) as { access_token: string; expires_in: number };
  tokenCache = {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in - 120) * 1000,
  };
  return tokenCache.token;
}

let orgIdCache: number | null = null;

/** Возвращает orgId организации (первый доступный в ACL). */
export async function getOrgId(): Promise<number> {
  if (orgIdCache !== null) return orgIdCache;
  const acls = await asaRequest<{ data: Array<{ orgId: number; orgName: string }> }>(
    'GET',
    '/acls',
    undefined,
    /* withOrg */ false,
  );
  const org = acls.data?.[0];
  if (!org) throw new Error('ASA: нет доступных организаций в /acls');
  orgIdCache = org.orgId;
  return orgIdCache;
}

/** Низкоуровневый запрос к ASA API с Bearer-токеном и X-AP-Context. */
export async function asaRequest<T = unknown>(
  method: 'GET' | 'POST',
  path: string,
  payload?: unknown,
  withOrg = true,
): Promise<T> {
  const token = await getAccessToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
  if (payload !== undefined) headers['Content-Type'] = 'application/json';
  if (withOrg) headers['X-AP-Context'] = `orgId=${await getOrgId()}`;

  const res = await request(`${ASA_API_BASE}${path}`, {
    method,
    headers,
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  });
  const text = await res.body.text();
  if (res.statusCode >= 400) {
    throw new Error(`ASA ${method} ${path} → ${res.statusCode}: ${text}`);
  }
  return JSON.parse(text) as T;
}

/**
 * Поисковая популярность термов.
 *
 * ВАЖНО: официальный Campaign Management API (этот модуль, Bearer-токен) НЕ
 * отдаёт popularity для произвольных ключей — проверено живьём (все пути 404).
 * Метрика доступна только через внутренний эндпоинт дашборда (Cookie-сессия) —
 * см. scrapers/asaDashboard.ts → keywordPopularity().
 *
 * Реэкспортируем оттуда, чтобы был один публичный вход.
 */
export { keywordPopularity as searchVolumeASA } from './asaDashboard.js';

/** Диагностика: проверяет токен и orgId. Запуск: tsx src/scrapers/asa.ts */
export async function probeAsa(): Promise<void> {
  if (!isAsaConfigured()) {
    throw new Error('ASA не сконфигурирован — заполни ASA_* в .env');
  }
  const token = await getAccessToken();
  console.log('✅ access_token получен, длина:', token.length);
  const orgId = await getOrgId();
  console.log('✅ orgId:', orgId);
}

// Прямой запуск файла = диагностика доступа.
if (import.meta.url === `file://${process.argv[1]}`) {
  probeAsa().catch((e) => {
    console.error('❌', e.message);
    process.exit(1);
  });
}
