# RankRadar — ASO-аналитика для App Store и Google Play

*[English version](README.md)*

Собственный ASO-сервис (App Store Optimization): для любого приложения и любого
ключевого слова считает **Rank** (позицию), **Volume** (спрос) и **Difficulty**
(сложность продвижения), хранит их историю, подбирает набор ключей, по которым
приложение индексируется, и превращает результат в приоритизированный план
действий.

Состоит из трёх частей:

- **REST API на Fastify** поверх PostgreSQL,
- **веб-дашборд** (`public/`) с анализом и графиками истории,
- **расширение для Chrome** (`extension/`), которое анализирует ту страницу
  стора, что открыта прямо сейчас.

Данные берутся из собственных эндпоинтов сторов — нативного поиска App Store
(того же, которым пользуется клиент на iPhone), popularity из Apple Search Ads и
`batchexecute`-RPC витрины Google Play, — а не у сторонних ASO-сервисов.

---

## Метрики

| Метрика | Что это | Откуда берётся |
|---|---|---|
| **Rank** | Позиция приложения в выдаче по ключу | iOS: нативный поиск App Store (`MZSearch.woa`), полный ранжированный список. Android: `batchexecute`-RPC витрины — глубина 230-250 против ~30 у HTML-страницы |
| **Volume** | Поисковый спрос на ключ, шкала 5-100 | Настоящая popularity из Apple Search Ads, если настроена сессия; иначе взвешенная эвристика (информативность префикса в автокомплите, насыщенность выдачи, штраф за длинный хвост). Для Android — подсказки Google Play, медиана установок топа и опционально веб-объёмы Keyword Planner |
| **Difficulty** | Насколько трудно пробиться в топ, шкала 5-100 | Сила приложений в топе: лог-нормализованные установки (Android) / число отзывов (iOS), плюс сигналы `titleMatch`, `brand` и конкурентов |

Веса формул лежат в `src/analytics/weights.ts` и переопределяются из `weights.json`
(переменная `WEIGHTS_PATH`); `src/calibrateWeights.ts` подбирает их grid-search'ем
по эталонной выгрузке.

---

## Подбор ключей (discovery)

`src/analytics/discoverByUrl.ts` работает как фоновая задача в БД — с
прогрессивной выдачей результатов, отменой и восстановлением после рестарта:

1. **Сиды** — название, основной жанр, топ-20 частотных слов и топ-15 биграмм
   описания, плюс термины, намайненные из метаданных конкурентов.
2. **Расширение автокомплитом** — две волны сторовых подсказок по сидам
   (`DISCOVERY_HINTS_PER_SEED`, `DISCOVERY_SECOND_WAVE_SEEDS`); так вылезает
   длинный хвост, которого нет ни в названии, ни в описании.
3. **Фильтр релевантности** — эвристика по ядру приложения плюс опциональный
   LLM-проход (`src/analytics/relevance.ts`), который отсекает off-topic запросы
   и бренды конкурентов. Ранжированные ключи не отсекаются никогда: ранг сам по
   себе доказывает релевантность.
4. **Замер** — rank/volume/difficulty по каждому кандидату, параллельно через
   пулы каналов.
5. **Сохранение** — итоговый набор термов пишется в `app_candidate_keywords`,
   поэтому следующий прогон по тому же приложению пропускает дорогое расширение,
   а снимок всех метрик уходит в `metric_checks` для графиков истории.

---

## Структура проекта

```
src/
├── api/
│   ├── server.ts            # REST API (поиск, метрики, история, discovery, SERP)
│   └── extensionRoutes.ts   # авторизация, пейволл, подписка, трекинг, инсайты
├── analytics/
│   ├── appstore/{volume,difficulty}.ts
│   ├── googleplay/{volume,difficulty}.ts
│   ├── discovery.ts, discoverByUrl.ts   # генерация кандидатов + фоновая задача
│   ├── relevance.ts         # фильтрация релевантности (эвристика + LLM)
│   ├── signals.ts           # общая нормализация (logNorm, hint, brand, titleMatch)
│   ├── weights.ts           # веса формул, переопределяются из weights.json
│   └── insights.ts          # приоритизированный план действий (квадрант, цели)
├── scrapers/
│   ├── native.ts            # нативный поиск App Store + карта витрин + channel pool
│   ├── appstore.ts          # iTunes Search/Lookup + подсказки + кэш app-info
│   ├── googleplay.ts        # Google Play (собственный парсер /store/search)
│   ├── gplayRpc.ts          # batchexecute-RPC — глубокие ранги Android
│   ├── finsky/              # мобильный protobuf-API Play (точные установки, bulkDetails)
│   ├── asa.ts, asaDashboard.ts  # popularity из Apple Search Ads
│   ├── googleAds.ts         # объёмы Keyword Planner (опциональный сигнал спроса)
│   ├── http.ts              # слот-пул HTTP, троттлинг, backpressure
│   └── proxy.ts             # пул прокси с кулдауном ротации
├── jobs/
│   ├── collect.ts, recheck.ts, digest.ts, scheduler.ts
├── tracking/                # трекинг позиций + детект значимых движений
├── payments/provider.ts     # абстракция PaymentProvider (stub -> Paddle)
├── db/                      # schema.sql, repo.ts, pool.ts, migrate.ts
└── cli.ts, importXlsx.ts, calibrateWeights.ts, compareFox.ts
```

Ключевые таблицы: `apps`, `keywords`, `app_keywords`, `rank_snapshots`,
`metric_checks`, `volume_estimates`, `discovery_jobs`, `app_candidate_keywords`,
`keyword_cache`, `users`, `payments`, `subscriptions`, `tracked_apps`.

---

## Быстрый старт

```bash
docker compose up -d          # PostgreSQL 17 на localhost:5433
npm install
cp .env.example .env          # заполнить DATABASE_URL и JWT_SECRET
npm run db:migrate
npm run dev                   # API + дашборд на http://localhost:3000
```

`JWT_SECRET` обязателен в проде — без него сервер не стартует. Сгенерировать:

```bash
openssl rand -hex 32
```

### npm-скрипты

| Скрипт | Что делает |
|---|---|
| `npm run dev` | API + дашборд с hot reload (tsx watch) |
| `npm run build` / `npm start` | Сборка в `dist/`, затем миграция и запуск сервера |
| `npm run db:migrate` | Накатить `src/db/schema.sql` |
| `npm run scrape` | CLI: `track-app`, `track-keyword`, `collect`, `search` |
| `npm run scheduler` | Планировщик (пересъём метрик каждые 3 часа, дайджесты) |
| `npm run import-xlsx` | Импорт сторонней выгрузки ключей в словарь |
| `npm run typecheck` | `tsc --noEmit` |

---

## API

**Публичные**

| Эндпоинт | Назначение |
|---|---|
| `GET /apps/search?q=&country=&platform=` | Найти приложение в сторе |
| `GET /apps/:id` · `/apps/:id/keywords` · `/apps/:id/metrics` | Карточка приложения, его ключи, метрики онлайн |
| `GET /apps/:id/discover` | Запустить или опросить подбор ключей по приложению |
| `GET /discover/by-url?url=&fresh=` | Подбор по вставленной ссылке на стор |
| `GET /discover/job/:id` · `/discover/job/:id/export.csv` | Состояние задачи, экспорт в CSV |
| `GET /keywords` · `/rank` · `/serp` | Метрики ключа, одна позиция, полная ранжированная выдача |
| `GET /bulk` · `/charts` · `/languages` | Таблица приложения×ключи, топ-чарты, языки витрин |
| `GET /history` · `/history/all` · `/apps/:id/keywords/:kw/history` | История метрик для графиков |
| `GET /health` · `/health/asa` · `/health/apple` | Живость, состояние ASA-сессии, счётчики каналов/прокси и детект бана |

**Расширение / аккаунт** (`Authorization: Bearer <jwt>`)

| Эндпоинт | Назначение |
|---|---|
| `POST /auth/register` · `/auth/login` · `GET /auth/me` | bcrypt + JWT (30 дней) |
| `GET /ext/analyze` · `/ext/job/:id` | Анализ открытой страницы стора; сводка бесплатна, полный список ключей за пейволлом |
| `GET /ext/job/:id/export.xlsx` | Экспорт в XLSX (по оплате) |
| `GET /ext/keyword` · `/ext/keyword-apps` | Метрики одного ключа и его топ-100 |
| `POST /ext/insights` | Приоритизированный план действий (цель + `lang=en\|ru`) |
| `POST /ext/track` · `GET /ext/tracked` · `DELETE /ext/track/:id` | Трекинг позиций с рядами для спарклайнов |
| `POST /payment/checkout` · `/payment/confirm` · `GET /payment/status/:id` | Подписка за слоем `PaymentProvider` |
| `POST /events` | Продуктовая аналитика |

---

## Расширение для Chrome

`extension/` (Manifest V3, сейчас v3.0.1). При открытии попапа на странице App
Store или Google Play анализ этого приложения стартует автоматически: плитки
сводки, полная таблица ключей с Rank/Volume/Difficulty, квадрант
спрос×сложность, AI-план действий, вкладка Keyword для разовых проверок и
вкладка Tracking со спарклайнами. Интерфейс EN/RU, оформление — дизайн-система
Promobile. Материалы листинга и чек-лист ревью — в
[`docs/WEBSTORE.md`](docs/WEBSTORE.md).

---

## Конфигурация

Всё читается из `.env` (полный список с комментариями — в
[`.env.example`](.env.example)).

| Группа | Переменные |
|---|---|
| Основное | `DATABASE_URL`, `PORT`, `JWT_SECRET`, `PUBLIC_URL`, `NODE_ENV` |
| Скрейпинг | `DEFAULT_COUNTRY`, `SCRAPE_DELAY_MS`, `SCRAPE_MAX_RETRIES`, `APPLE_CHANNELS`, `HTTP_CHANNELS`, `HTTP_PENALTY_MS` |
| Discovery | `MAX_KEYWORDS`, `BFS_MAX_DEPTH`, `MAX_CONCURRENT_JOBS`, `REFRESH_AFTER_MS`, `DISCOVERY_MAX_CANDIDATES`, `DISCOVERY_MAX_CANDIDATES_GP`, `DISCOVERY_HINTS_PER_SEED`, `DISCOVERY_SEED_LIMIT`, `DISCOVERY_SECOND_WAVE_SEEDS` |
| Прокси | `PROXY_URL`, `PROXY_URLS` (через запятую, round-robin с 5-минутным кулдауном после ошибки) |
| Apple Search Ads | `ASA_CLIENT_ID`, `ASA_TEAM_ID`, `ASA_KEY_ID`, `ASA_PRIVATE_KEY_PATH`, `ASA_DASH_SESSION_PATH`, `ASA_DASH_ADAM_ID` |
| Google Ads | `GOOGLE_ADS_*` (объёмы Keyword Planner, опционально) |
| AI | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `INSIGHTS_MAX_KEYWORDS` |
| Монетизация | `SUBSCRIPTION_PRICE_CENTS`, `SUBSCRIPTION_CURRENCY`, `SUBSCRIPTION_PERIOD_DAYS`, `REPORT_PRICE_CENTS`, `REPORT_CURRENCY` |
| Трекинг и алерты | `TRACKING_TERMS_LIMIT`, `TRACKING_RANK_DELTA`, `DIGEST_MIN_HOURS`, `RESEND_API_KEY`, `EMAIL_FROM`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |

Кроме `DATABASE_URL` и `JWT_SECRET` ничего не обязательно — каждая опциональная
интеграция деградирует мягко: нет ASA-сессии → volume по эвристике, нет ключа
Anthropic → детерминированные инсайты по правилам, нет прокси → прямое
соединение.

### Пропускная способность

Эффективный rate ≈ `каналы / SCRAPE_DELAY_MS`. Дефолты (6 каналов × 900 мс ≈
6.7 req/s) прогоняют ~200 ключей примерно за 30 с — внутри 90-секундного бюджета
клиента. `/health/apple` отдаёт счётчики пулов и прокси: без них поднимать число
каналов вслепую опасно, а троттлинг выглядит как «позиция 250+», то есть как
валидные данные.

---

## Деплой

Прод на Railway: `npm start` сначала накатывает миграцию, потом поднимает сервер,
поэтому достаточно обычного `git push`. `docker-compose.yml` нужен только для
локального PostgreSQL.

Секреты (`*.pem`, `.asa-session*`, `.finsky-state*`, `.env`) в `.gitignore` и не
должны попадать в репозиторий.

---

## Что почитать дальше

- [`docs/HOW_IT_WORKS.md`](docs/HOW_IT_WORKS.md) — формулы метрик и эндпоинты сторов подробно
- [`docs/CALIBRATION.md`](docs/CALIBRATION.md) — ранбук точности и подбор весов
- [`docs/WEBSTORE.md`](docs/WEBSTORE.md) — листинг в Chrome Web Store и чек-лист ревью
- [`docs/integration-with-promobile-back.md`](docs/integration-with-promobile-back.md) — интеграция с бэкендом Promobile
- [`src/scrapers/finsky/README.md`](src/scrapers/finsky/README.md) — protobuf-клиент Play и почему он не используется для рангов
