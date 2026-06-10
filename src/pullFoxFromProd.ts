/**
 * Тянет эталон FoxData из прод-API бека (GraphQL getUserGroupsKeywords) и
 * сохраняет его в формате харнесса compareFox.ts.
 *
 * Авторизация бека — httpOnly-кука accessToken. Берём её из залогиненной
 * сессии платформы (DevTools → Application → Cookies → accessToken) и
 * передаём через env ACCESS_TOKEN.
 *
 *   GRAPHQL_URL=https://api.promobile.app/graphql \
 *   ACCESS_TOKEN=<кука accessToken> \
 *   npx tsx src/pullFoxFromProd.ts \
 *     --appId=389801252 --store=APP_STORE --country=us --language=en \
 *     --out=/tmp/fox.json
 *
 * store: APP_STORE | GOOGLE_STORE ; на выходе platform ios|android для compareFox.
 */
import { writeFileSync } from 'node:fs';

function flag(name: string, def?: string): string | undefined {
  const f = process.argv.find((a) => a.startsWith(`--${name}=`));
  return f ? f.split('=').slice(1).join('=') : def;
}

const GRAPHQL_URL = process.env.GRAPHQL_URL || 'https://backend.promobile.app/graphql';
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN || '';
const appId = flag('appId');
const store = (flag('store', 'APP_STORE') || 'APP_STORE').toUpperCase();
const country = (flag('country', 'us') || 'us').toLowerCase();
const language = flag('language', country === 'us' ? 'en' : country)!;
const out = flag('out', '/tmp/fox.json')!;

if (!ACCESS_TOKEN) { console.error('Нужен env ACCESS_TOKEN (кука accessToken из залогиненной сессии).'); process.exit(1); }
if (!appId) { console.error('Нужен --appId=...'); process.exit(1); }

const QUERY = `query($appId:String!,$country:String!,$language:String!,$store:Store!){
  getUserGroupsKeywords(appId:$appId,country:$country,language:$language,store:$store){
    groupName
    keywords{
      keyword
      position
      SecondaryKeywordMetrics{ difficulty popularity date }
    }
  }
}`;

interface SkMetric { difficulty?: number; popularity?: number; date?: string }
interface Kw { keyword: string; position?: string | null; SecondaryKeywordMetrics?: SkMetric[] }
interface Group { groupName: string; keywords: Kw[] }

function parsePos(p?: string | null): number | null {
  if (p == null) return null;
  const n = parseInt(String(p).replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null; // "250+" → 250 (вне топа)
}

(async () => {
  const cookie = `accessToken=${ACCESS_TOKEN}${REFRESH_TOKEN ? `; refreshToken=${REFRESH_TOKEN}` : ''}`;
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ query: QUERY, variables: { appId, country, language, store } }),
  });
  const json: any = await res.json();
  if (json.errors) { console.error('GraphQL errors:', JSON.stringify(json.errors, null, 2)); process.exit(1); }
  const groups: Group[] = json.data?.getUserGroupsKeywords || [];
  const seen = new Set<string>();
  const rows: { term: string; rank: number | null; volume: number | null; difficulty: number | null }[] = [];
  for (const g of groups) for (const k of g.keywords || []) {
    const term = (k.keyword || '').trim();
    if (!term || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    const m = (k.SecondaryKeywordMetrics || [])[0] || {};
    rows.push({
      term,
      rank: parsePos(k.position),
      volume: m.popularity ?? null,
      difficulty: m.difficulty ?? null,
    });
  }
  const platform = store === 'GOOGLE_STORE' ? 'android' : 'ios';
  const payload = { platform, appId, country, language, rows };
  writeFileSync(out, JSON.stringify(payload, null, 2));
  console.error(`Сохранено ${rows.length} ключей из ${groups.length} групп → ${out}`);
  console.error(`  с position: ${rows.filter((r) => r.rank != null).length}, с popularity: ${rows.filter((r) => r.volume != null).length}, с difficulty: ${rows.filter((r) => r.difficulty != null).length}`);
})().catch((e) => { console.error('Ошибка:', e?.message || e); process.exit(1); });
