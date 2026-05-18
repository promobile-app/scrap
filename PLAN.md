# ASO-сервис (аналог FoxData) — План

Цель: собственный сервис ASO-аналитики для **Apple App Store**, дающий
данные **Rank** (позиция приложения по ключевому слову), **Search Volume /
Popularity** и **Position** (позиция в топ-чартах категорий).

Стек: **Node.js + TypeScript**, PostgreSQL, очередь задач, REST API,
позже — фронтенд-дашборд.

---

## Откуда берутся данные (источники)

| Метрика | Источник | Реалистичность |
|---|---|---|
| Rank (позиция по ключу) | Скрейпинг поисковой выдачи App Store (storefront search API) | Полностью реально |
| Position (топ-чарты) | Apple RSS-фиды top charts по категориям/странам | Полностью реально |
| Метаданные приложения | iTunes Lookup API | Полностью реально |
| Autocomplete / подсказки | Apple search hints endpoint | Полностью реально |
| Search Volume / Popularity | **Apple Search Ads API** (метрика popularity) | Нужен аккаунт ASA |
| Search Volume (без ASA) | Эвристика: autocomplete-ранг + кол-во результатов + тренд | Приблизительно |

Ключевой вывод: «точно как в FoxData» по Search Volume = нужен аккаунт
Apple Search Ads. До его подключения используем эвристическую оценку и
помечаем её как «estimated».

---

## Этапы

### Этап 1. Каркас проекта
- [ ] Инициализация Node.js + TypeScript проекта
- [ ] Структура папок (src/scrapers, src/api, src/db, src/jobs)
- [ ] Конфиг (env), линтер, tsconfig
- [ ] Docker Compose: PostgreSQL

### Этап 2. Скрейперы App Store (ядро данных)
- [ ] `appLookup` — метаданные приложения по id/bundleId (iTunes Lookup)
- [ ] `searchApps` — поисковая выдача по ключу (storefront search)
- [ ] `getRank` — позиция конкретного app по ключу в выдаче
- [ ] `topCharts` — топ-чарты по категории/стране (RSS)
- [ ] `suggest` — autocomplete-подсказки
- [ ] Антибан: ротация User-Agent, троттлинг, retry/backoff

### Этап 3. База данных
- [ ] Схема: apps, keywords, rank_snapshots, chart_snapshots, volume_estimates
- [ ] Миграции
- [ ] Слой репозиториев

### Этап 4. Search Volume
- [ ] Эвристическая оценка popularity (autocomplete + результаты)
- [ ] Интеграция Apple Search Ads API (после получения аккаунта)
- [ ] Нормализация в шкалу 5–100 как у FoxData

### Этап 5. Фоновые задачи
- [ ] Планировщик: ежедневный сбор rank-снимков по отслеживаемым ключам
- [ ] Сбор топ-чартов
- [ ] Очередь задач + воркер

### Этап 6. REST API
- [ ] GET /apps/:id — инфо о приложении
- [ ] GET /apps/:id/keywords — отслеживаемые ключи + текущий rank
- [ ] GET /keywords/:kw — volume, конкуренция, топ-приложения
- [ ] GET /charts — топ-чарты
- [ ] POST /track — добавить приложение/ключ в отслеживание
- [ ] История (тренды) по rank/volume

### Этап 7. Аналитика и фронтенд
- [ ] ASO-метрики: difficulty score, traffic score
- [ ] Подбор ключевых слов (keyword research)
- [ ] Анализ конкурентов
- [ ] Дашборд (графики трендов)

---

## Источник rank (вариант 1-расширенный — реализован)
- Используется **нативный поиск App Store** (`MZSearch.woa/wa/search` → `MZStore`,
  поле `pageData.bubbles[0].results`) — тот же endpoint, что в iPhone-приложении.
- Отдаёт **полную ранжированную выдачу** (200+ позиций), а не урезанные 200
  legacy iTunes Search API. Работает анонимно: нужны только нативные заголовки
  (`X-Apple-Store-Front`, App Store User-Agent, device GUID). Apple ID не нужен.
- Модуль `src/scrapers/native.ts`. На «кредит»/UA: 213 результатов (FoxData ~248).
- Метаданные приложений из топа подтягиваются батч-lookup'ом (`lookupApps`).

## Google Play (добавлено)
- Скрейпер `src/scrapers/googleplay.ts` на базе `google-play-scraper`
  (официального API у Play Store нет — парсинг веб-страниц).
- Аналитика: `src/analytics/gp.ts` — оценка Volume и Difficulty.
- API: параметр `?platform=android` для `/apps/search`, `/apps/:id/metrics`,
  `/charts`. По умолчанию `ios`.
- Дашборд: переключатель 🍎 App Store / 🤖 Google Play.
- appId в Google Play — имя пакета (строка), напр. `ua.moneyveo`.

## Прогресс
- 2026-05-18: план создан.
- 2026-05-18: Этапы 1–7 реализованы (MVP):
  - Каркас Node.js+TS, PostgreSQL в Docker (порт 5433 — 5432 занят локальным PG).
  - Скрейперы: appLookup, searchApps, getRank, topChart, suggest — проверены.
  - Схема БД + миграции применены.
  - Аналитика: estimateVolume (эвристика), estimateDifficulty. ASA — заглушка.
  - Фоновый сбор: collectRanks/Charts/Volumes + суточный планировщик.
  - REST API (Fastify) + дашборд на public/index.html.

## Что осталось / следующие шаги
- [ ] Завести аккаунт Apple Search Ads и реализовать src/scrapers/asa.ts
      (точная метрика popularity вместо эвристики).
- [ ] Прокси-пул и капча-обход при росте объёма скрейпинга.
- [ ] Графики трендов на дашборде (история rank/volume).
- [ ] Keyword research: генерация кандидатов из suggest + конкурентов.
- [ ] Мультистрановость и категории чартов (genre_id).

## Запуск
- `docker compose up -d` — поднять PostgreSQL.
- `npm run db:migrate` — применить схему.
- `npm run dev` — API + дашборд на http://localhost:3000.
- `npm run scrape -- track-keyword <appId> <term>` — добавить отслеживание.
- `npm run scrape -- collect` — разовый сбор данных.
- `npm run scrape -- scheduler` (через tsx) или src/jobs/scheduler.ts — суточный сбор.
