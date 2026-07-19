# Как работает ASO-скрапер

Собственный аналог FoxData для App Store и Google Play. Сервис собирает по
ключевым словам три метрики — **Rank** (позиция), **Volume** (поисковый объём) и
**Difficulty** (сложность продвижения) — и хранит их историю для построения
графиков.

Стек: **Node.js + TypeScript (ESM)**, **Fastify** (API), **PostgreSQL** (хранилище),
парсинг публичных сторовых эндпоинтов Apple и библиотека `google-play-scraper`.

---

## 1. Структура проекта

```
src/
├── api/
│   ├── server.ts            # REST API (поиск, метрики, история, discovery)
│   └── extensionRoutes.ts   # auth + маршруты Chrome-расширения
├── analytics/
│   ├── difficulty.ts        # формула DIFFICULTY (iOS)
│   ├── volume.ts            # формула VOLUME (iOS)
│   ├── discovery.ts         # подбор ключей в стиле FoxData
│   ├── discoverByUrl.ts     # background-job подбора по URL + кэш
│   └── gp.ts               # аналоги volume/difficulty для Google Play
├── scrapers/
│   ├── native.ts           # нативный поиск App Store (RANK) + channel pool
│   ├── appstore.ts         # iTunes Search/Lookup API + suggest + app-info кэш
│   ├── googleplay.ts       # Google Play через google-play-scraper
│   ├── charts.ts           # топ-чарты App Store (RSS)
│   ├── http.ts             # HTTP слот-пул (rate limiting)
│   ├── asa.ts              # Apple Search Ads — ЗАГЛУШКА (точный объём)
│   └── storeUrl.ts         # парсинг ссылок на приложения
├── jobs/
│   ├── collect.ts          # разовый сбор метрик (rank/volume/charts)
│   ├── recheck.ts          # переснятие истории всех метрик
│   └── scheduler.ts        # планировщик: recheck каждые 3 часа
├── db/
│   ├── schema.sql          # схема таблиц
│   ├── repo.ts             # слой доступа к данным
│   ├── pool.ts / migrate.ts
├── config.ts               # конфиг из .env
├── cli.ts                  # CLI (track-app, track-keyword, collect, search)
└── importXlsx.ts           # импорт выгрузок FoxData (XLSX)
```

### Ключевые таблицы БД (`src/db/schema.sql`)

| Таблица | Назначение |
|---|---|
| `apps`, `keywords`, `app_keywords` | приложения, ключи и их связи |
| `rank_snapshots` | история позиций (rank, total_results, ts) |
| `metric_checks` | история **всех** метрик (rank+volume+difficulty) для графиков |
| `volume_estimates` | история оценок объёма |
| `discovery_jobs` | фоновые задачи подбора (status, keywords JSONB) |
| `app_candidate_keywords` | постоянный словарь кандидатов на приложение |
| `keyword_cache` | кэш выдачи по ключу (ids, volume, difficulty) |

---

## 2. RANK — позиция приложения по ключу

**Источник: реальная нативная выдача App Store** (та же, что видит приложение
App Store на iPhone), а не публичный iTunes Search.

Файл: `src/scrapers/native.ts`

```
GET https://search.itunes.apple.com/WebObjects/MZSearch.woa/wa/search
    ?clientApplication=Software&term=<query>&guid=<device-guid>
```

Запрос имитирует клиент App Store через заголовки:

- `X-Apple-Store-Front: {storefrontId}-{langId},29` — витрина по стране/языку
  (US=143441, RU=143469, DE=143443 …; en=1, ru=16, de=4 …)
- `User-Agent: AppStore/3.0 iOS/17.5.1 model/iPhone15,3 …`
- `X-Apple-Client-Application: com.apple.AppStore`

Ответ — JSON со списком приложений в `pageData.bubbles[0].results[]`. Позиция
вычисляется напрямую:

```ts
export async function getRank(appId, term, country, language) {
  const ids = await nativeSearchIds(term, country, language);
  const idx = ids.indexOf(String(appId));
  return { rank: idx === -1 ? null : idx + 1, total: ids.length };
}
```

**Channel pool**: по умолчанию 4 виртуальных канала (`APPLE_CHANNELS=4`), у каждого
свой device-GUID и свой throttle-слот. Round-robin по наименее загруженному каналу
даёт ×4 пропускную способность с разными «отпечатками».

**Google Play**: `src/scrapers/googleplay.ts` → `gpGetRank()` использует
`google-play-scraper` (`gplay.search({ term, country, lang, num: 250 })`) и ищет
package id в результатах.

Сохранение: `saveRankSnapshot()` → `rank_snapshots`.

---

## 3. VOLUME — поисковый объём (популярность ключа)

> Точный объём от Apple пока **не подключён** (см. §6). Сейчас используется
> собственная **оценка** из двух открытых сигналов.

Файл: `src/analytics/volume.ts`

Сигналы:

1. **Позиция в автодополнении (вес 60%).** Эндпоинт подсказок Apple:
   ```
   GET https://search.itunes.apple.com/WebObjects/MZSearchHints.woa/wa/hints
   ```
   (XML-plist, парсим `<string>…</string>`). Чем выше термин в подсказках —
   тем больше объём. `hintSignal = 1 − позиция/кол-во_подсказок` (или 0, если нет).

2. **Насыщенность выдачи (вес 40%).** Сколько приложений конкурируют за ключ
   (`nativeSearchIds`), по логарифмической шкале:
   `resultSignal = log10(totalResults+1) / log10(201)`.

3. **Штраф за длину запроса** (long-tail ищут реже): 4+ слова ×0.6, 3 слова ×0.8,
   1–2 слова ×1.0.

**Формула:**
```ts
const raw   = (hintSignal * 0.6 + resultSignal * 0.4) * lengthPenalty;
const score = Math.round(5 + raw * 95);   // шкала 5..100 (как у FoxData)
```

**Google Play**: `src/analytics/gp.ts` → `gpEstimateVolume()` — та же формула на
основе `gpSuggest` + `gpSearch`.

Сохранение: `saveVolumeEstimate()` → `volume_estimates`.

---

## 4. DIFFICULTY — сложность продвижения

Файл: `src/analytics/difficulty.ts`

Идея: чем «жирнее» приложения в топе выдачи (по числу отзывов), тем труднее
пробиться. Берём **топ-10** выдачи, подгружаем их метаданные через iTunes Lookup
API (`searchApps` → `lookupAppsCached`) и считаем средний `ratingCount`.

**Формула:**
```ts
const avgRatingCount = avg(top10.map(a => a.ratingCount));
const strength = Math.min(1, Math.log10(avgRatingCount + 1) / 6);
const score    = Math.round(5 + strength * 95);   // шкала 5..100
```

Интерпретация: 0 отзывов → score 5 (легко); ~1000 → ~52; ~1 млн → 100 (невозможно).

**Google Play**: `src/analytics/gp.ts` → `gpEstimateDifficulty()` — топ-8 и делитель
`/7` вместо `/6`.

---

## 5. Внешние сервисы и эндпоинты

| Назначение | Сервис / эндпоинт | Где в коде |
|---|---|---|
| Rank (iOS) | `search.itunes.apple.com/.../MZSearch.woa/wa/search` (нативная выдача App Store) | `scrapers/native.ts` |
| Подсказки (volume) | `search.itunes.apple.com/.../MZSearchHints.woa/wa/hints` | `scrapers/appstore.ts` |
| Метаданные/поиск (difficulty) | iTunes Search & Lookup API | `scrapers/appstore.ts` |
| Топ-чарты | App Store RSS (`rss.applemarketingtools.com` / itunes RSS) | `scrapers/charts.ts` |
| Rank/Volume/Difficulty (Android) | `google-play-scraper` (парсит веб Play Store) | `scrapers/googleplay.ts`, `analytics/gp.ts` |
| **Точный объём (план)** | **Apple Search Ads API** — `api.searchads.apple.com/api/v5/...` | `scrapers/asa.ts` *(заглушка)* |

**Apple Search Ads (заглушка).** `src/scrapers/asa.ts` пока бросает ошибку. Когда
будет подключён — даст точную метрику `popularity` (шкала 5–100, как у FoxData)
вместо оценки из §3. Требует OAuth2 c ES256-JWT и переменные
`ASA_CLIENT_ID`, `ASA_TEAM_ID`, `ASA_KEY_ID`, `ASA_PRIVATE_KEY_PATH`.

Прокси/токены для парсинга Apple **не используются** — запросы идут напрямую с
имитацией клиентских заголовков и троттлингом.

---

## 6. Производительность: пулы и кэши

- **HTTP слот-пул** (`src/scrapers/http.ts`): `HTTP_CHANNELS=4` слота, каждый
  с паузой `SCRAPE_DELAY_MS` (≈600 мс) → ~6–7 req/sec на iTunes lookup/suggest.
- **Apple channel pool** (`native.ts`): 4 канала с разными GUID для ранков.
  Вместе → до ×16 одновременности.
- **App-info кэш** (`appstore.ts`): LRU + TTL 6 ч, до 20k записей. Топовые
  приложения повторяются между ключами — кэш дедуплицирует iTunes-запросы.
- **Keyword cache** (`keyword_cache` в БД + память, TTL 6 ч): нулевая задержка
  на повторные ключи.
- **Постоянный словарь кандидатов** (`app_candidate_keywords`): если уже есть
  ≥10 кандидатов на приложение — дорогой BFS-подбор пропускается.

---

## 7. Фоновые задачи

- **`jobs/collect.ts`** (`npm run collect`): разовый проход по всем tracked
  парам app+keyword — пишет `rank_snapshots`, чарты и `volume_estimates`.
- **`jobs/recheck.ts` + `scheduler.ts`**: каждые **3 часа** пересобирает rank +
  volume + difficulty по всем уникальным целям и пишет в `metric_checks`
  (для графиков). iOS и Android считаются параллельно.
- **Discovery jobs** (`analytics/discoverByUrl.ts`): асинхронный подбор ключей
  по URL приложения. Статусы `pending → running → done/error`, очередь до
  `MAX_CONCURRENT_JOBS=4`. Кэш результата 6 ч; фоновый рефреш, если старше 30 мин.
- **Восстановление зомби-джобов**: при старте сервера `failStaleDiscoveryJobs()`
  помечает зависшие `running/pending` задачи как `error` (после рестарта процесса).

---

## 8. Импорт выгрузок FoxData (XLSX)

`src/importXlsx.ts`:

```bash
npm run import-xlsx -- ./Keywords-Ranked-Export.xlsx \
  --app-id=544007664 --country=us [--platform=ios|android]
```

Ожидаемые колонки: `Keyword`, `Ranking`, `Vol`, `Diff`, `Results`. Импорт пишет
постоянный словарь (`app_candidate_keywords`), снимок истории (`metric_checks`) и
готовую `discovery_jobs` со статусом `done` — расширение получает результат мгновенно.

---

## 9. Основные API-эндпоинты (`src/api/server.ts`)

| Метод | Назначение |
|---|---|
| `GET /apps/search?q=&country=&platform=` | поиск приложений |
| `GET /apps/:appId/metrics?term=&country=&platform=` | rank, inTop10, volume, difficulty, топ-10 конкурентов |
| `GET /history?platform=&appId=&term=&country=` | история метрик для графиков |
| `GET /apps/:appId/discover?country=` | синхронный подбор ключей (FoxData-стиль) |
| `GET /discover/by-url?url=&fresh=1` | асинхронный подбор → возвращает `jobId` |
| `GET /discover/job/:jobId` | поллинг статуса/результата |
| `GET /discover/job/:jobId/export.csv` | экспорт CSV |

Auth и маршруты расширения — в `src/api/extensionRoutes.ts` (JWT, TTL 30 дней).

---

## Сводка метрик

| Метрика | Источник | Формула |
|---|---|---|
| **Rank** | нативная выдача App Store / Google Play | позиция в списке (1-based) или `null` |
| **Volume** | автодополнение (60%) + насыщенность выдачи (40%) − штраф за длину | `5 + (hint·0.6 + result·0.4)·lengthPenalty · 95` |
| **Difficulty** | средний `ratingCount` топ-10 выдачи | `5 + min(1, log10(avgRatingCount+1)/6) · 95` |

> Volume и Difficulty сейчас **оценочные** (по открытым сигналам). Точный объём
> появится после подключения Apple Search Ads API (`src/scrapers/asa.ts`).
