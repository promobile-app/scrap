import 'dotenv/config';

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://aso:aso@localhost:5432/aso',
  port: Number(process.env.PORT ?? 3000),
  defaultCountry: process.env.DEFAULT_COUNTRY ?? 'us',
  scrapeDelayMs: Number(process.env.SCRAPE_DELAY_MS ?? 600),
  scrapeMaxRetries: Number(process.env.SCRAPE_MAX_RETRIES ?? 3),
  jwtSecret: process.env.JWT_SECRET ?? 'dev-insecure-change-me',
  reportPriceCents: Number(process.env.REPORT_PRICE_CENTS ?? 499),
  reportCurrency: process.env.REPORT_CURRENCY ?? 'USD',
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
  // AI-слой (insights). Без ключа эндпоинт /ext/insights работает на
  // детерминированном правилном фолбэке — продукт не падает.
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
    maxKeywords: Number(process.env.INSIGHTS_MAX_KEYWORDS ?? 40),
  },
};
