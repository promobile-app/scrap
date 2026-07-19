# Публикация RankRadar в Chrome Web Store — чек-лист и материалы

## Чек-лист перед загрузкой

- [ ] Зарегистрировать аккаунт разработчика Chrome Web Store ($5, единоразово):
      https://chrome.google.com/webstore/devconsole
- [ ] Задеплоить бэкенд с новыми env: `JWT_SECRET` (обязателен!), `SUBSCRIPTION_*`,
      `TELEGRAM_*` (опционально).
- [ ] Проверить, что https://scrap-production-c0db.up.railway.app/privacy.html открывается
      (privacy policy — обязательное поле листинга).
- [ ] Собрать zip: содержимое папки `extension/` (manifest в корне архива):
      `cd extension && zip -r ../rankradar-3.0.0.zip . -x 'gen-icons.mjs'`
- [ ] В Developer Console заполнить листинг (тексты ниже), загрузить скриншоты
      (1280×800, минимум 1, лучше 4-5) и промо-тайл 440×280.
- [ ] Data usage disclosure (форма в консоли): см. раздел ниже — заполняется 1:1
      по privacy policy.
- [ ] Отправить на ревью. Обычно 1-3 рабочих дня.

## Листинг (EN)

**Name:** RankRadar — ASO Keyword Analyzer

**Summary (132 chars max):**
One-click ASO keyword analytics for any App Store or Google Play app: ranks,
search volume, difficulty and an AI action plan.

**Description:**

Open any app page on the Apple App Store or Google Play, click RankRadar, and
get a full ASO keyword report in about a minute:

- Every keyword the app ranks for, with its exact position
- Search volume (5–100) and ranking difficulty (5–100) for each keyword
- Top-10 competitors for every keyword — tap any row to see who ranks above you
- AI action plan: which keywords to push, defend or skip, and why
- Keyword checker: type any keyword and see volume, difficulty and the top apps
- Excel export of the full report

Free: summary of every analysis (how many keywords, how many in Top 3 / Top 10).
Pro subscription: full keyword lists, AI plans, keyword checks and Excel export
for unlimited apps.

Works for both stores, multiple countries. Built for indie developers, ASO
specialists and marketing teams who want FoxData-level insight at an indie price.

**Category:** Developer Tools (или Productivity)

**Language:** English

## Data usage disclosure (форма в консоли)

| Вопрос | Ответ |
|---|---|
| Personally identifiable info | Yes — email (аутентификация) |
| Authentication info | Yes — пароль (хранится как bcrypt-хэш) |
| Web history | **No** (только URL активной вкладки стора по явному действию) |
| User activity | Yes — product analytics (клики внутри расширения) |
| Website content | No |
| Продажа данных третьим лицам | No |
| Использование данных не по назначению | No |

## Permission justifications (спросят на ревью)

- **activeTab, tabs** — read the URL of the store page the user is viewing to
  start analysis of that app with one click. No browsing history is collected.
- **storage** — keep the user signed in; cache language preference and report
  state locally.
- **host_permissions (backend URL)** — the extension communicates exclusively
  with our own API backend.

## Примечания

- Цена в попапе ($9.99/mo) захардкожена в `popup.html` и должна совпадать с
  `SUBSCRIPTION_PRICE_CENTS` на бэке. При смене цены менять в двух местах.
- Privacy policy хостится бэкендом: `public/privacy.html` → `/privacy.html`.
- Версия расширения: `extension/manifest.json` → `3.0.0` (подписочная модель).
