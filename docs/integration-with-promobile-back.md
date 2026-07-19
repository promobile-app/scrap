# Подключение БД скрапера к бэкенду promobile-back (замена FoxData)

Документ описывает, как «прицепить» базу собственного скрапера к бэкенду
`promobile-back`, который сейчас берёт ASO-метрики (popularity / difficulty / rank)
из платного внешнего API **FoxData**. Цель — кормить бэк своими данными вместо
FoxData (полностью или как фолбэк), сэкономив на лимите 1200 запросов/день.

---

## 1. Что есть с двух сторон

### Скрапер (`/Volumes/secondary/scrapper`)
- **СУБД:** PostgreSQL 17, драйвер `pg` (без ORM), пул в [`src/db/pool.ts`](../src/db/pool.ts).
- **Подключение:** env `DATABASE_URL` (`postgres://aso:aso@localhost:5433/aso` локально; на проде — Railway).
- **API:** Fastify, прод на Railway `https://scrap-production-c0db.up.railway.app`.
- **Главная таблица метрик** — [`metric_checks`](../src/db/schema.sql) (schema.sql:64):

  | поле | тип | смысл |
  |---|---|---|
  | `platform` | TEXT | `ios` / `android` |
  | `app_id` | TEXT | iOS — числовой trackId; Android — package name |
  | `app_title` | TEXT | название приложения |
  | `term` | TEXT | ключевое слово |
  | `country` | TEXT | страна (`us`, …) |
  | `language` | TEXT | язык |
  | `rank` | INTEGER | позиция приложения по ключу (NULL = вне выдачи) |
  | `total_results` | INTEGER | размер выдачи по ключу |
  | `volume` | INTEGER | **поисковый объём, шкала 5–100 (= FoxData POP)** |
  | `difficulty` | INTEGER | **сложность, шкала 5–100 (= FoxData DIFF)** |
  | `captured_at` | TIMESTAMPTZ | момент снятия |

  Индекс: `(platform, app_id, term, country, captured_at)`.
- Дополнительно: `volume_estimates` (история объёма по `keyword_id`, поле `score` 5–100,
  «как popularity у FoxData» — комментарий прямо в схеме), `keyword_cache` (TTL 6 ч),
  `app_candidate_keywords` (словарь кандидатов).

> Ключевой факт: скрапер **уже сознательно нормализует метрики в шкалу FoxData (5–100)**.
> Поэтому маппинг почти 1:1, без перекалибровки.

### Бэкенд (`/Users/yaroslavsemianchuk/WebstormProjects/promobile-back`)
- **СУБД:** PostgreSQL, **Prisma 4.8**. Подключение: env `DB_URL`
  ([`prisma/schema.prisma`](../../../Users/yaroslavsemianchuk/WebstormProjects/promobile-back/prisma/schema.prisma), datasource).
  Клиент — `PrismaService` (`src/db/db.service.ts`), один datasource.
- **FoxData — это внешний HTTP-API, а не БД:**
  - `src/provider/fox-data/fox-data.service.ts` — `FoxDataService`
    (`getKeywordMetrics`, `getKeywordMetricsRank`).
  - `src/common/helpers/fox-data-client.ts` — `FoxDataClient`: fetch к
    `https://api.foxdata.com`, rate-limit 1200/день, мок-ответы для local/dev,
    счётчик кредитов; ключ env `FOXDATA_API_KEY`.
  - Вызывается из `src/scraper/scraper.service.ts`
    (`getSecondaryKewyordMetrics`, `getStoreKeywordPosition`).
- **Куда складываются метрики FoxData (Prisma-модели):**

  | таблица | поля | назначение |
  |---|---|---|
  | `secondary_keyword_metrics` | `keywordId`, `difficulty`, `popularity`, `date` | метрики для ключа, известного в БД |
  | `secondary_keyword_metrics_agnostic` | `keyword`, `appId`(String), `difficulty`, `popularity`, `date`, `country`, `language`, `store` | метрики без привязки к записи приложения |
  | `app_search_index` / `app_search_index_agnostic` | `keyword`/`keywordId`, `appId`, `index`, `dateOfSearch`, `country`, `language`, `store` | позиции (rank) в поиске |

  Запись — `ScraperService.saveSecondaryMetrics()` (createMany в обе таблицы).

### Форма ответа FoxData (это и есть «контракт», который надо повторить)
`FoxDataClient` (мок-ветка в `fox-data-client.ts`) показывает, что бэк ждёт:

```jsonc
// POST /apiv1/expose/keyword/metrics
{ "code": 200, "data": { "result": [
    { "keyword": "...", "pop": { "value": 49, "date": "2025-08-15" },
                        "diff": { "value": 46, "date": "2025-08-15" } }
  ], "creditsCost": { /* … */ } } }
```
Rank приходит аналогично из `/apiv1/expose/keyword/metrics-rank`.

---

## 2. Маппинг полей (скрапер → бэк)

| FoxData / бэк | скрапер `metric_checks` | примечание |
|---|---|---|
| `pop.value` (popularity) | `volume` | обе шкалы 5–100 |
| `diff.value` (difficulty) | `difficulty` | обе шкалы 5–100 |
| rank `index` | `rank` | NULL = вне выдачи |
| `keyword` | `term` | точное совпадение строки |
| `appId` | `app_id` | iOS trackId / Android package |
| `country` | `country` | привести регистр (`US` ↔ `us`) |
| `language` | `language` | |
| `store` (`APP_STORE`/`GOOGLE_STORE`) | `platform` (`ios`/`android`) | нужен переходник enum ↔ строка |
| `date` | `captured_at` | |

Две вещи, которые надо явно обработать в адаптере:
1. **store ↔ platform:** `APP_STORE→ios`, `GOOGLE_STORE→android`.
2. **Регистр страны/языка:** FoxData отдаёт `US`, скрапер хранит `us`.

---

## 3. Варианты подключения

Четыре подхода — от самого изолированного к самому связанному. Рекомендация — **Вариант A**.

### Вариант A — Скрапер как drop-in замена FoxData через HTTP (рекомендуется)
Скрапер уже развёрнут на Railway и имеет Fastify-API. Добавляем в него endpoint(ы),
повторяющие **форму ответа FoxData**, и на беке подменяем источник за тем же
интерфейсом `FoxDataService`.

- **Скрапер:** новый роут, например `POST /metrics/keyword` и `POST /metrics/keyword-rank`,
  которые читают `metric_checks` (последний снимок по `(platform, app_id, term, country)`)
  и отдают `{ code, data: { result: [...] } }` в формате FoxData.
- **Бэк:** новый класс `ScraperMetricsClient` с тем же контрактом, что `FoxDataClient`,
  плюс флаг-переключатель источника (env `METRICS_PROVIDER=scraper|foxdata`).
  `ScraperService` не меняется — он по-прежнему дергает `FoxDataService`.

**Плюсы:** нулевая связанность БД-БД; две базы остаются независимыми; легко
включить фолбэк на FoxData; ничего не ломается в Prisma-схеме; единственная точка
изменения на беке. **Минусы:** сетевой хоп; нужно поддерживать формат ответа.

```ts
// promobile-back: src/common/helpers/scraper-metrics-client.ts (эскиз)
export class ScraperMetricsClient {
  private base = process.env.SCRAPER_API_URL; // https://scrap-production-c0db.up.railway.app
  async getKeywordMetrics(raw: { appId: string; keywords: string[]; region: string; store?: string }) {
    const r = await fetch(`${this.base}/metrics/keyword`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.SCRAPER_API_KEY },
      body: JSON.stringify(raw),
    });
    return r.json(); // ВАЖНО: вернуть { code, data: { result: [{keyword, pop, diff}] } }
  }
  // getKeywordMetricsRank — аналогично, /metrics/keyword-rank
}
```

### Вариант B — Прямое второе подключение к БД скрапера из бэка
На беке поднимаем второй Prisma-клиент (отдельный `schema` с `output` и своим
datasource `SCRAPER_DB_URL`) **или** просто `pg.Pool` к базе скрапера и читаем
`metric_checks` напрямую.

- Отдельный Prisma-схема-файл `prisma/scraper.schema.prisma` с
  `datasource db { url = env("SCRAPER_DB_URL") }` и моделями только для чтения,
  либо легче — нативный `pg` pool в отдельном `ScraperDbModule`.

**Плюсы:** нет промежуточного API, типобезопасный доступ. **Минусы:** жёсткая
связанность двух баз; нужен сетевой доступ из инфраструктуры бэка к Postgres
скрапера (на Railway — связать проекты/частную сеть или открыть public URL);
две схемы Prisma усложняют сборку; миграции скрапера могут ломать чтение.

### Вариант C — Репликация / синхронизация данных в БД бэка (ETL)
Периодический джоб (cron на беке или в скрапере) переносит свежие строки
`metric_checks` → `secondary_keyword_metrics_agnostic` / `app_search_index_agnostic`.
Маппинг из раздела 2; идемпотентный upsert по `(keyword, appId, country, language, store, date)`.

**Плюсы:** данные живут в родной БД бэка, работают существующие GraphQL-запросы и
джоины; нет рантайм-зависимости от скрапера. **Минусы:** задержка синка; дублирование
данных; нужно писать и обслуживать ETL.

### Вариант D — Postgres FDW / logical replication
`postgres_fdw` на стороне бэка создаёт foreign table на `metric_checks` скрапера,
либо logical replication публикует таблицу. Бэк читает как локальную таблицу.

**Плюсы:** «нативно», без кода-синхронизатора. **Минусы:** требует прав суперюзера/
расширений (на managed-Postgres Railway может быть недоступно), сетевой доступ
между инстансами, более хрупкая инфраструктура. Для managed-хостинга обычно overkill.

---

## 4. Рекомендация

1. **Старт — Вариант A.** Скрапер уже на Railway с API и метриками в нужной шкале;
   подмена источника за `FoxDataService` минимальна и обратима (флаг
   `METRICS_PROVIDER`, фолбэк на FoxData при пустом ответе скрапера).
2. **Если со временем нужны джоины/история в родной БД бэка** — добавить **Вариант C**
   (ETL-синк agnostic-таблиц) как фоновую дозагрузку, оставив A как онлайн-путь.
3. **Вариант B/D** — только если будет общая частная сеть Railway между проектами и
   осознанное желание разделять одну БД; иначе они добавляют связанность без выгоды.

---

## 5. План внедрения (Вариант A)

**На стороне скрапера (`/Volumes/secondary/scrapper`):**
1. Добавить роут `POST /metrics/keyword` в [`src/api/server.ts`](../src/api/server.ts):
   принимает `{ store|platform, appId, country, keywords[] }`, делает `DISTINCT ON`
   выборку последнего снимка из `metric_checks`, мапит в формат FoxData
   (`{ keyword, pop:{value}, diff:{value}, date }`).
2. Добавить `POST /metrics/keyword-rank` (отдаёт `rank` тем же контрактом).
3. Защитить роуты простым `x-api-key` (env), т.к. API публичный на Railway.
4. Пример выборки:
   ```sql
   SELECT DISTINCT ON (term)
          term, volume, difficulty, rank, captured_at
   FROM metric_checks
   WHERE platform = $1 AND app_id = $2 AND lower(country) = lower($3)
         AND term = ANY($4::text[])
   ORDER BY term, captured_at DESC;
   ```

**На стороне бэка (`promobile-back`):**
5. Создать `ScraperMetricsClient` (форма ответа = FoxData) и обернуть выбор источника
   в `FoxDataService` через env `METRICS_PROVIDER` (`scraper` | `foxdata`).
6. Env: `SCRAPER_API_URL`, `SCRAPER_API_KEY`, `METRICS_PROVIDER`.
7. Включить фолбэк: если скрапер вернул пусто по ключу → дернуть FoxData (опционально).
8. `ScraperService.saveSecondaryMetrics()` и парсинг `pop/diff` **не трогаем** — формат тот же.

**Проверки перед продом:**
- Сверить 20–30 ключей: значения скрапера vs FoxData (popularity/difficulty/rank) —
  есть ли систематический сдвиг (см. memory: калибровка ещё не прогнана).
- Совпадение `appId` (iOS trackId / Android package) с тем, что шлёт бэк.
- Регистр `country`/`language` и маппинг `store ↔ platform`.

---

## 6. Открытые вопросы / риски

- **Калибровка.** По заметкам проекта метрики скрапера ещё не калибровались против
  эталона — перед заменой FoxData стоит прогнать сверку, иначе popularity/difficulty
  могут систематически расходиться.
- **Покрытие.** FoxData отвечает по любому ключу; скрапер отдаёт только то, что уже
  снято в `metric_checks`. Нужен фолбэк (FoxData или синхронный досбор) для незнакомых
  ключей, иначе будут пустые ответы.
- **Свежесть.** Scheduler скрапера обновляет метрики периодически; данные могут быть
  старше, чем live-запрос к FoxData. Решается полем `captured_at` + порогом «свежести».
- **Сетевой доступ (для B/D).** Прямое подключение к БД скрапера требует частной сети
  Railway или публичного доступа к Postgres — у Вариантов A/C этой проблемы нет.

---

### Сводка ключевых файлов

| Сторона | Файл | Роль |
|---|---|---|
| Скрапер | `src/db/pool.ts` | пул `pg`, `DATABASE_URL` |
| Скрапер | `src/db/schema.sql` | таблица `metric_checks` (volume/difficulty/rank) |
| Скрапер | `src/api/server.ts` | Fastify-API (сюда добавить `/metrics/*`) |
| Бэк | `prisma/schema.prisma` | datasource `DB_URL`, модели `secondary_keyword_metrics*` |
| Бэк | `src/provider/fox-data/fox-data.service.ts` | точка подмены источника |
| Бэк | `src/common/helpers/fox-data-client.ts` | контракт ответа (повторить) |
| Бэк | `src/scraper/scraper.service.ts` | парсинг pop/diff + `saveSecondaryMetrics()` |
</content>
</invoke>
