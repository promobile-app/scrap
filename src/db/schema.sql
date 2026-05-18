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
