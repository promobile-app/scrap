import 'dotenv/config';

// Прод-окружение: Railway выставляет RAILWAY_ENVIRONMENT_NAME, иначе NODE_ENV.
const isProduction =
  process.env.NODE_ENV === 'production' || Boolean(process.env.RAILWAY_ENVIRONMENT_NAME);

// В проде дефолтный JWT-секрет недопустим: любой сможет подделать токены.
if (isProduction && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET обязателен в production — задай env-переменную.');
}

export const config = {
  isProduction,
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://aso:aso@localhost:5432/aso',
  port: Number(process.env.PORT ?? 3000),
  defaultCountry: process.env.DEFAULT_COUNTRY ?? 'us',
  scrapeDelayMs: Number(process.env.SCRAPE_DELAY_MS ?? 600),
  scrapeMaxRetries: Number(process.env.SCRAPE_MAX_RETRIES ?? 3),
  jwtSecret: process.env.JWT_SECRET ?? 'dev-insecure-change-me',
  reportPriceCents: Number(process.env.REPORT_PRICE_CENTS ?? 499),
  reportCurrency: process.env.REPORT_CURRENCY ?? 'USD',
  // Подписка — основная модель монетизации (расширение).
  subscription: {
    priceCents: Number(process.env.SUBSCRIPTION_PRICE_CENTS ?? 999),
    currency: process.env.SUBSCRIPTION_CURRENCY ?? 'USD',
    periodDays: Number(process.env.SUBSCRIPTION_PERIOD_DAYS ?? 30),
  },
  // Алерты (протухла ASA-сессия, оплаты, критические ошибки) — в Telegram.
  // Оба поля пустые => алерты выключены, всё пишется только в лог.
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
    chatId: process.env.TELEGRAM_CHAT_ID ?? '',
  },
  // Трекинг позиций + email-дайджест (retention-фича подписки).
  tracking: {
    // Сколько топ-ключей приложения мониторим (по volume) — ограничивает
    // нагрузку recheck: 30 ключей × N приложений каждые 3 часа.
    termsLimit: Number(process.env.TRACKING_TERMS_LIMIT ?? 30),
    // Порог значимого движения позиции для дайджеста.
    rankDelta: Number(process.env.TRACKING_RANK_DELTA ?? 3),
    // Не чаще одного дайджеста в N часов на пользователя.
    digestMinHours: Number(process.env.DIGEST_MIN_HOURS ?? 20),
  },
  // Email (дайджесты): Resend HTTP API. Пустой ключ => email выключен,
  // дайджест просто пишется в лог (для локальной разработки).
  email: {
    resendApiKey: process.env.RESEND_API_KEY ?? '',
    from: process.env.EMAIL_FROM ?? 'RankRadar <alerts@rankradar.app>',
  },
  // Базовый публичный URL сервиса — для ссылок в письмах (unsubscribe).
  publicUrl: process.env.PUBLIC_URL ?? 'https://scrap-production-c0db.up.railway.app',
  asa: {
    clientId: process.env.ASA_CLIENT_ID ?? '',
    teamId: process.env.ASA_TEAM_ID ?? '',
    keyId: process.env.ASA_KEY_ID ?? '',
    privateKeyPath: process.env.ASA_PRIVATE_KEY_PATH ?? '',
  },
  // Сессия дашборда app-ads.apple.com — источник keyword popularity (5-100).
  // Официальный API такого не отдаёт; берём через внутренний эндпоинт дашборда.
  // sessionPath указывает на gitignored JSON: { cookie, xsrf, adamId, orgId }.
  asaDash: {
    sessionPath: process.env.ASA_DASH_SESSION_PATH ?? './.asa-session.json',
    // adamId любого приложения в орге — нужен как query-контекст; на значение
    // популярности не влияет (popularity глобальна по ключу+стране).
    adamId: Number(process.env.ASA_DASH_ADAM_ID ?? 0),
  },
  // Веса формул volume/difficulty. Файл создаётся калибровкой
  // (src/calibrateWeights.ts --write); без него работают дефолты из
  // analytics/weights.ts.
  weightsPath: process.env.WEIGHTS_PATH ?? './weights.json',
  // Google Ads API (Keyword Planner) — web-объёмы поиска как сигнал спроса
  // для Google Play volume. Все поля пустые => сигнал выключен, работает
  // эвристика без него.
  googleAds: {
    developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN ?? '',
    clientId: process.env.GOOGLE_ADS_CLIENT_ID ?? '',
    clientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET ?? '',
    refreshToken: process.env.GOOGLE_ADS_REFRESH_TOKEN ?? '',
    customerId: (process.env.GOOGLE_ADS_CUSTOMER_ID ?? '').replace(/-/g, ''),
    loginCustomerId: (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ?? '').replace(/-/g, ''),
    apiVersion: process.env.GOOGLE_ADS_API_VERSION ?? 'v20',
  },
  // AI-слой (insights). Без ключа эндпоинт /ext/insights работает на
  // детерминированном правилном фолбэке — продукт не падает.
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
    maxKeywords: Number(process.env.INSIGHTS_MAX_KEYWORDS ?? 40),
  },
};
