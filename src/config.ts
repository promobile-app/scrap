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
  // AI-слой (insights). Без ключа эндпоинт /ext/insights работает на
  // детерминированном правилном фолбэке — продукт не падает.
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
    maxKeywords: Number(process.env.INSIGHTS_MAX_KEYWORDS ?? 40),
  },
};
