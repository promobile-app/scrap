-- ASO-сервис: схема базы данных

-- Приложения, которые мы отслеживаем / встречали в выдаче.
CREATE TABLE IF NOT EXISTS apps (
  app_id          BIGINT PRIMARY KEY,
  bundle_id       TEXT,
  title           TEXT NOT NULL,
  developer       TEXT,
  developer_id    BIGINT,
  primary_genre   TEXT,
  primary_genre_id INTEGER,
  icon            TEXT,
  rating          REAL,
  rating_count    INTEGER,
  country         TEXT NOT NULL DEFAULT 'us',
  tracked         BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ключевые слова (уникальны в паре term+country).
CREATE TABLE IF NOT EXISTS keywords (
  id          SERIAL PRIMARY KEY,
  term        TEXT NOT NULL,
  country     TEXT NOT NULL DEFAULT 'us',
  tracked     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (term, country)
);

-- Связь «приложение отслеживается по ключевому слову».
CREATE TABLE IF NOT EXISTS app_keywords (
  app_id      BIGINT NOT NULL REFERENCES apps(app_id) ON DELETE CASCADE,
  keyword_id  INTEGER NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  PRIMARY KEY (app_id, keyword_id)
);

-- Снимки позиции приложения по ключу во времени (Rank).
CREATE TABLE IF NOT EXISTS rank_snapshots (
  id            BIGSERIAL PRIMARY KEY,
  app_id        BIGINT NOT NULL REFERENCES apps(app_id) ON DELETE CASCADE,
  keyword_id    INTEGER NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  rank          INTEGER,           -- NULL = вне выдачи
  total_results INTEGER NOT NULL,
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rank_app_kw_time
  ON rank_snapshots (app_id, keyword_id, captured_at DESC);

-- Снимки позиции в топ-чартах (Position).
CREATE TABLE IF NOT EXISTS chart_snapshots (
  id          BIGSERIAL PRIMARY KEY,
  app_id      BIGINT NOT NULL REFERENCES apps(app_id) ON DELETE CASCADE,
  chart_type  TEXT NOT NULL,       -- top-free / top-paid
  country     TEXT NOT NULL,
  genre_id    INTEGER,             -- NULL = общий чарт
  position    INTEGER,             -- NULL = вне топа
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chart_app_time
  ON chart_snapshots (app_id, captured_at DESC);

-- История проверок «приложение + ключ» (Метрики по ключу) — для графиков.
-- app_id здесь TEXT: App Store — числовой id, Google Play — имя пакета.
CREATE TABLE IF NOT EXISTS metric_checks (
  id            BIGSERIAL PRIMARY KEY,
  platform      TEXT NOT NULL,        -- ios / android
  app_id        TEXT NOT NULL,
  app_title     TEXT,
  term          TEXT NOT NULL,
  country       TEXT NOT NULL,
  language      TEXT,
  rank          INTEGER,              -- NULL = вне выдачи
  total_results INTEGER,
  volume        INTEGER,
  difficulty    INTEGER,
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_metric_checks_lookup
  ON metric_checks (platform, app_id, term, country, captured_at);

-- Оценки поискового объёма по ключевому слову (Search Volume / Popularity).
CREATE TABLE IF NOT EXISTS volume_estimates (
  id            BIGSERIAL PRIMARY KEY,
  keyword_id    INTEGER NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  score         INTEGER NOT NULL,  -- шкала 5-100, как popularity у FoxData
  source        TEXT NOT NULL,     -- 'estimated' | 'apple_search_ads'
  total_results INTEGER,
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_volume_kw_time
  ON volume_estimates (keyword_id, captured_at DESC);

-- Фоновые задачи подбора ключей по приложению (до 1000 ключей).
-- keywords хранит массив найденных ключей с метриками (заполняется по ходу).
CREATE TABLE IF NOT EXISTS discovery_jobs (
  id          BIGSERIAL PRIMARY KEY,
  job_key     TEXT NOT NULL,        -- platform|appId|country
  platform    TEXT NOT NULL,
  app_id      TEXT NOT NULL,
  app_title   TEXT,
  country     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending', -- pending|running|done|error
  total       INTEGER NOT NULL DEFAULT 0,
  processed   INTEGER NOT NULL DEFAULT 0,
  keywords    JSONB NOT NULL DEFAULT '[]',
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_discovery_jobs_key
  ON discovery_jobs (job_key, created_at DESC);

-- Кэш выдачи магазина по ключу (не зависит от приложения).
-- Переживает рестарты сервиса и шарится между всеми задачами.
CREATE TABLE IF NOT EXISTS keyword_cache (
  platform      TEXT NOT NULL,
  country       TEXT NOT NULL,
  term          TEXT NOT NULL,
  ids           JSONB NOT NULL,
  total_results INTEGER NOT NULL,
  volume        INTEGER NOT NULL,
  difficulty    INTEGER NOT NULL,
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, country, term)
);
CREATE INDEX IF NOT EXISTS idx_keyword_cache_time
  ON keyword_cache (captured_at);

-- Постоянный словарь «кандидатных ключей» для пары (платформа, приложение, страна).
-- Заполняется при каждом успешном discovery-прогоне и переживает рестарты.
-- Любой следующий пользователь, запросивший то же приложение, не пересчитывает
-- набор кандидатов с нуля — мы лишь освежаем для них метрики/ранки.
CREATE TABLE IF NOT EXISTS app_candidate_keywords (
  platform     TEXT NOT NULL,
  app_id       TEXT NOT NULL,
  country      TEXT NOT NULL,
  term         TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, app_id, country, term)
);
CREATE INDEX IF NOT EXISTS idx_app_candidate_kw_lookup
  ON app_candidate_keywords (platform, app_id, country);

-- Пользователи extension (email+password).
CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Привязка job -> user и факт оплаты.
ALTER TABLE discovery_jobs ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE discovery_jobs ADD COLUMN IF NOT EXISTS paid BOOLEAN NOT NULL DEFAULT FALSE;

-- Подписки (основная модель монетизации).
-- У пользователя максимум одна строка: продление двигает current_period_end.
CREATE TABLE IF NOT EXISTS subscriptions (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  plan               TEXT NOT NULL DEFAULT 'pro',
  status             TEXT NOT NULL DEFAULT 'pending', -- pending|active|canceled|expired
  provider           TEXT NOT NULL DEFAULT 'stub',
  external_id        TEXT,                             -- id подписки у провайдера (Paddle и т.п.)
  current_period_end TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_active
  ON subscriptions (user_id, status, current_period_end);

-- Платежи (stub-провайдер; провайдер заменим позже).
CREATE TABLE IF NOT EXISTS payments (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id      BIGINT NOT NULL REFERENCES discovery_jobs(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'USD',
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending|success|failed
  provider    TEXT NOT NULL DEFAULT 'stub',
  external_id TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_job ON payments (job_id);

-- Миграция под подписки: платёж теперь может быть подписочным (без job).
ALTER TABLE payments ALTER COLUMN job_id DROP NOT NULL;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'report'; -- report|subscription
ALTER TABLE payments ADD COLUMN IF NOT EXISTS subscription_id BIGINT REFERENCES subscriptions(id) ON DELETE SET NULL;

-- Отслеживаемые приложения (retention-фича подписки): пользователь «подписан»
-- на приложение, scheduler переснимает его ключи, дайджест шлёт изменения.
CREATE TABLE IF NOT EXISTS tracked_apps (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform       TEXT NOT NULL,             -- ios / android
  app_id         TEXT NOT NULL,
  app_title      TEXT,
  country        TEXT NOT NULL,
  terms          JSONB NOT NULL DEFAULT '[]', -- мониторимые ключи (топ по volume)
  alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_digest_at TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, platform, app_id, country)
);
CREATE INDEX IF NOT EXISTS idx_tracked_apps_user ON tracked_apps (user_id);

-- Аналитика событий extension.
CREATE TABLE IF NOT EXISTS analytics_events (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT REFERENCES users(id) ON DELETE SET NULL,
  event       TEXT NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_analytics_event_time
  ON analytics_events (event, created_at DESC);
