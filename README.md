# RankRadar — ASO analytics for App Store & Google Play

*[Русская версия](README.ru.md)*

A self-hosted ASO (App Store Optimization) analytics service: for any app and any
keyword it measures **Rank**, **Volume** and **Difficulty**, stores their history,
discovers the keyword set an app is indexed for, and turns the result into a
prioritized action plan.

It ships as three parts:

- a **Fastify REST API** over PostgreSQL,
- a **web dashboard** (`public/`) for analysis and history charts,
- a **Chrome extension** (`extension/`) that analyzes the store page you are
  currently looking at.

Data comes from the stores' own endpoints — the native App Store search that the
iPhone client uses, Apple Search Ads popularity, and the Google Play
`batchexecute` RPC — not from third-party ASO vendors.

---

## Metrics

| Metric | What it is | How it is obtained |
|---|---|---|
| **Rank** | The app's position in the search results for a keyword | iOS: native App Store search (`MZSearch.woa`), full ranked list. Android: the storefront `batchexecute` RPC — depth 230-250 versus ~30 from the HTML page |
| **Volume** | Search demand for the keyword, scale 5-100 | Real Apple Search Ads popularity when a session is configured; otherwise a weighted heuristic (autocomplete prefix informativeness, result-set saturation, long-tail penalty). For Android — Google Play suggestions, median installs of the top, and optionally Keyword Planner web volumes |
| **Difficulty** | How hard it is to break into the top, scale 5-100 | Strength of the apps in the top: log-normalized installs (Android) / rating counts (iOS), plus `titleMatch`, `brand` and competitor signals |

Formula weights live in `src/analytics/weights.ts` and can be overridden from a
`weights.json` (see `WEIGHTS_PATH`) — `src/calibrateWeights.ts` fits them by grid
search against a reference export.

---

## Keyword discovery

`src/analytics/discoverByUrl.ts` runs as a DB-backed background job (progressive
results, cancellable, resumable):

1. **Seeds** — app title, primary genre, top-20 frequent words and top-15 bigrams
   of the description, plus terms mined from competitor metadata.
2. **Autocomplete expansion** — two waves of store suggestions over the seeds
   (`DISCOVERY_HINTS_PER_SEED`, `DISCOVERY_SECOND_WAVE_SEEDS`), which surfaces the
   long tail that is in neither the title nor the description.
3. **Relevance filter** — a heuristic core filter plus an optional LLM pass
   (`src/analytics/relevance.ts`) that drops off-topic queries and competitor
   brands. Ranked keywords are never dropped: a rank proves relevance.
4. **Measurement** — rank/volume/difficulty for every candidate, in parallel over
   the channel pools.
5. **Persistence** — the final term set is upserted into `app_candidate_keywords`,
   so the next run for the same app skips the expensive expansion, and a snapshot
   of every metric goes into `metric_checks` for the history charts.

---

## Project layout

```
src/
├── api/
│   ├── server.ts            # REST API (search, metrics, history, discovery, SERP)
│   └── extensionRoutes.ts   # auth, paywall, subscription, tracking, insights
├── analytics/
│   ├── appstore/{volume,difficulty}.ts
│   ├── googleplay/{volume,difficulty}.ts
│   ├── discovery.ts, discoverByUrl.ts   # candidate generation + background job
│   ├── relevance.ts         # heuristic + LLM relevance filtering
│   ├── signals.ts           # shared normalization (logNorm, hint, brand, titleMatch)
│   ├── weights.ts           # formula weights, overridable from weights.json
│   └── insights.ts          # prioritized action plan (quadrant, goals)
├── scrapers/
│   ├── native.ts            # native App Store search + storefront map + channel pool
│   ├── appstore.ts          # iTunes Search/Lookup + suggestions + app-info cache
│   ├── googleplay.ts        # Google Play (/store/search parser)
│   ├── gplayRpc.ts          # batchexecute RPC — deep Android ranks
│   ├── finsky/              # Play mobile protobuf API (exact installs, bulkDetails)
│   ├── asa.ts, asaDashboard.ts  # Apple Search Ads popularity
│   ├── googleAds.ts         # Keyword Planner volumes (optional demand signal)
│   ├── http.ts              # HTTP slot pool, throttling, backpressure
│   └── proxy.ts             # proxy pool with rotation cooldown
├── jobs/
│   ├── collect.ts, recheck.ts, digest.ts, scheduler.ts
├── tracking/                # rank tracking + significant-movement detection
├── payments/provider.ts     # PaymentProvider abstraction (stub -> Paddle)
├── db/                      # schema.sql, repo.ts, pool.ts, migrate.ts
└── cli.ts, importXlsx.ts, calibrateWeights.ts, compareFox.ts
```

Key tables: `apps`, `keywords`, `app_keywords`, `rank_snapshots`, `metric_checks`,
`volume_estimates`, `discovery_jobs`, `app_candidate_keywords`, `keyword_cache`,
`users`, `payments`, `subscriptions`, `tracked_apps`.

---

## Quick start

```bash
docker compose up -d          # PostgreSQL 17 on localhost:5433
npm install
cp .env.example .env          # fill in DATABASE_URL and JWT_SECRET
npm run db:migrate
npm run dev                   # API + dashboard on http://localhost:3000
```

`JWT_SECRET` is mandatory in production — the server refuses to start without it.
Generate one with:

```bash
openssl rand -hex 32
```

### npm scripts

| Script | What it does |
|---|---|
| `npm run dev` | API + dashboard with hot reload (tsx watch) |
| `npm run build` / `npm start` | Compile to `dist/`, then migrate and serve |
| `npm run db:migrate` | Apply `src/db/schema.sql` |
| `npm run scrape` | CLI: `track-app`, `track-keyword`, `collect`, `search` |
| `npm run scheduler` | Background scheduler (recheck every 3 hours, digests) |
| `npm run import-xlsx` | Import a third-party keyword export into the dictionary |
| `npm run typecheck` | `tsc --noEmit` |

---

## API

**Public**

| Endpoint | Purpose |
|---|---|
| `GET /apps/search?q=&country=&platform=` | Find an app in the store |
| `GET /apps/:id` · `/apps/:id/keywords` · `/apps/:id/metrics` | App card, its keywords, live metrics |
| `GET /apps/:id/discover` | Start or poll keyword discovery for an app |
| `GET /discover/by-url?url=&fresh=` | Discovery from a pasted store link |
| `GET /discover/job/:id` · `/discover/job/:id/export.csv` | Job state, CSV export |
| `GET /keywords` · `/rank` · `/serp` | Keyword metrics, a single rank, the full ranked SERP |
| `GET /bulk` · `/charts` · `/languages` | Bulk apps×keywords table, top charts, storefront languages |
| `GET /history` · `/history/all` · `/apps/:id/keywords/:kw/history` | Metric history for charts |
| `GET /health` · `/health/asa` · `/health/apple` | Liveness, ASA session state, channel/proxy counters and ban detection |

**Extension / account** (`Authorization: Bearer <jwt>`)

| Endpoint | Purpose |
|---|---|
| `POST /auth/register` · `/auth/login` · `GET /auth/me` | bcrypt + JWT (30 d) |
| `GET /ext/analyze` · `/ext/job/:id` | Analyze the open store page; summary is free, full keywords are gated |
| `GET /ext/job/:id/export.xlsx` | XLSX export (paid) |
| `GET /ext/keyword` · `/ext/keyword-apps` | Single-keyword metrics and its top-100 |
| `POST /ext/insights` | Prioritized action plan (goal + `lang=en\|ru`) |
| `POST /ext/track` · `GET /ext/tracked` · `DELETE /ext/track/:id` | Rank tracking with sparkline series |
| `POST /payment/checkout` · `/payment/confirm` · `GET /payment/status/:id` | Subscription flow behind `PaymentProvider` |
| `POST /events` | Product analytics events |

---

## Chrome extension

`extension/` (Manifest V3, currently v3.0.1). Opening the popup on an App Store or
Google Play page auto-starts an analysis of that app: summary tiles, the full
keyword table with Rank/Volume/Difficulty, a demand×difficulty quadrant, an AI
action plan, a Keyword tab for ad-hoc checks, and a Tracking tab with sparklines.
UI is EN/RU, styled on the Promobile design system. Store listing notes and the
review checklist are in [`docs/WEBSTORE.md`](docs/WEBSTORE.md).

---

## Configuration

Everything is read from `.env` (see [`.env.example`](.env.example) for the full,
commented list).

| Group | Variables |
|---|---|
| Core | `DATABASE_URL`, `PORT`, `JWT_SECRET`, `PUBLIC_URL`, `NODE_ENV` |
| Scraping | `DEFAULT_COUNTRY`, `SCRAPE_DELAY_MS`, `SCRAPE_MAX_RETRIES`, `APPLE_CHANNELS`, `HTTP_CHANNELS`, `HTTP_PENALTY_MS` |
| Discovery | `MAX_KEYWORDS`, `BFS_MAX_DEPTH`, `MAX_CONCURRENT_JOBS`, `REFRESH_AFTER_MS`, `DISCOVERY_MAX_CANDIDATES`, `DISCOVERY_MAX_CANDIDATES_GP`, `DISCOVERY_HINTS_PER_SEED`, `DISCOVERY_SEED_LIMIT`, `DISCOVERY_SECOND_WAVE_SEEDS` |
| Proxies | `PROXY_URL`, `PROXY_URLS` (comma-separated, round-robin with a 5-minute cooldown after a failure) |
| Apple Search Ads | `ASA_CLIENT_ID`, `ASA_TEAM_ID`, `ASA_KEY_ID`, `ASA_PRIVATE_KEY_PATH`, `ASA_DASH_SESSION_PATH`, `ASA_DASH_ADAM_ID` |
| Google Ads | `GOOGLE_ADS_*` (Keyword Planner volumes, optional) |
| AI | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `INSIGHTS_MAX_KEYWORDS` |
| Monetization | `SUBSCRIPTION_PRICE_CENTS`, `SUBSCRIPTION_CURRENCY`, `SUBSCRIPTION_PERIOD_DAYS`, `REPORT_PRICE_CENTS`, `REPORT_CURRENCY` |
| Tracking & alerts | `TRACKING_TERMS_LIMIT`, `TRACKING_RANK_DELTA`, `DIGEST_MIN_HOURS`, `RESEND_API_KEY`, `EMAIL_FROM`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |

Nothing beyond `DATABASE_URL` and `JWT_SECRET` is required — every optional
integration degrades gracefully (no ASA session → heuristic volume, no Anthropic
key → deterministic rule-based insights, no proxies → direct connection).

### Throughput

Effective rate ≈ `channels / SCRAPE_DELAY_MS`. The defaults (6 channels ×
900 ms ≈ 6.7 req/s) analyze ~200 keywords in about 30 s, inside the client's 90 s
budget. `/health/apple` exposes the pool and proxy counters — without them,
raising the channel count is guesswork, and throttling shows up as "position 250+"
that looks like valid data.

---

## Deployment

Deployed on Railway: `npm start` runs the migration and then the server, so a
plain `git push` is enough. `docker-compose.yml` is for local PostgreSQL only.

Secrets (`*.pem`, `.asa-session*`, `.finsky-state*`, `.env`) are gitignored and
must never be committed.

---

## Further reading

- [`docs/HOW_IT_WORKS.md`](docs/HOW_IT_WORKS.md) — metric formulas and store endpoints in detail
- [`docs/CALIBRATION.md`](docs/CALIBRATION.md) — accuracy runbook and weight fitting
- [`docs/WEBSTORE.md`](docs/WEBSTORE.md) — Chrome Web Store listing and review checklist
- [`docs/integration-with-promobile-back.md`](docs/integration-with-promobile-back.md) — integration with the Promobile backend
- [`src/scrapers/finsky/README.md`](src/scrapers/finsky/README.md) — the Play protobuf client and why it is not used for ranks
