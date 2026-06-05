// AI-слой над готовой discovery-джобой: превращает таблицу ключей
// {term, rank, volume(спрос), saturation, difficulty} в приоритизированный
// план действий с объяснениями. Это «слой суждения» поверх честных данных.
//
// Работает в двух режимах:
//   1. LLM (Anthropic Messages API, structured tool-output) — если задан ключ.
//   2. Детерминированный правильный фолбэк — всегда, без ключа/сети.
// В обоих случаях наружу отдаётся одинаковый валидный контракт InsightsResult,
// поэтому продукт никогда не падает из-за недоступности модели.
//
// Отзывы/рейтинги в сигнал НЕ входят (бэклог) — модели прямо запрещено на них
// ссылаться, чтобы не было галлюцинаций «по отзывам видно...».

import { config } from '../config.js';
import type { DiscoveryJobState, UrlKeyword } from './discoverByUrl.js';

export type Move = 'push' | 'monitor' | 'skip';
export type Goal = 'rank_up' | 'expand' | 'defend';

export interface InsightAction {
  term: string;
  move: Move;
  currentRank: number | null;
  reason: string;
  priority: number;
}

export interface InsightQuadrant {
  pushNow: string[];
  quickWins: string[];
  longShots: string[];
  ignore: string[];
}

export interface InsightsResult {
  appId: string;
  jobId: number;
  generatedAt: string;
  summary: string;
  actions: InsightAction[];
  quadrant: InsightQuadrant;
  meta: {
    model: string;
    dataQuality: 'estimated' | 'measured';
    keywordsAnalyzed: number;
  };
}

export interface InsightsOptions {
  goal?: Goal;
  locale?: string;
}

// --- Пороги решений (общие для правил и для system-промпта LLM) ------------
const DEMAND_LOW = 25; // ниже — спрос слишком мал, ключ не стоит правок
const DIFFICULTY_WALL = 65; // выше — конкуренция «стеной»
const QUICK_WIN_MIN = 11; // rank в [11..25] — один шаг до топ-10
const QUICK_WIN_MAX = 25;
const NEAR_TOP_MAX = 50; // rank в [26..50] — близко, но дальше
const HIGH_DEMAND = 50;

function ruLang(locale?: string): boolean {
  return (locale ?? '').toLowerCase().startsWith('ru');
}

// --- Детерминированная классификация одного ключа --------------------------

interface Classified {
  kw: UrlKeyword;
  move: Move;
  bucket: keyof InsightQuadrant | null; // null = monitor (уже в топе, не в квадранте)
  reason: string;
  opportunity: number; // выше = важнее (для сортировки и priority)
}

function classify(kw: UrlKeyword, goal: Goal, ru: boolean): Classified {
  const { rank, volume: demand, difficulty } = kw;
  const r = (en: string, rus: string) => (ru ? rus : en);

  // 1. Низкий спрос — пропускаем независимо от прочего.
  if (demand < DEMAND_LOW) {
    return {
      kw, move: 'skip', bucket: 'ignore',
      reason: r(
        `Low search demand (${demand}/100) — not worth metadata changes.`,
        `Низкий спрос (${demand}/100) — правки метаданных не окупятся.`,
      ),
      opportunity: demand - 200,
    };
  }

  // 2. Уже ранжируется.
  if (rank !== null) {
    if (rank <= 10) {
      // defend: если в топе, но конкуренция высокая — это не «расслабиться»,
      // а удерживать позицию.
      if (goal === 'defend' && difficulty >= HIGH_DEMAND) {
        return {
          kw, move: 'push', bucket: 'pushNow',
          reason: r(
            `Rank ${rank} but difficulty ${difficulty}/100 — defend this position, competitors are strong.`,
            `Позиция ${rank}, но сложность ${difficulty}/100 — удерживай, конкуренты сильны.`,
          ),
          opportunity: 90 + demand,
        };
      }
      return {
        kw, move: 'monitor', bucket: null,
        reason: r(
          `Already top-10 (rank ${rank}) — hold, don't spend edits here.`,
          `Уже в топ-10 (позиция ${rank}) — держим, правки не нужны.`,
        ),
        opportunity: demand - 100,
      };
    }
    if (rank <= QUICK_WIN_MAX) {
      // Главный приоритет: один шаг до топ-10.
      return {
        kw, move: 'push', bucket: 'quickWins',
        reason: r(
          `Rank ${rank} — one step from top-10. Highest-ROI edit.`,
          `Позиция ${rank} — один шаг до топ-10. Самый высокий ROI правок.`,
        ),
        opportunity: 1000 + demand - difficulty * 0.3,
      };
    }
    // rank 26+ — есть ранжирование, но дальше.
    if (difficulty >= DIFFICULTY_WALL) {
      return {
        kw, move: 'skip', bucket: 'longShots',
        reason: r(
          `Rank ${rank}, difficulty ${difficulty}/100 — wall of competition, deprioritize.`,
          `Позиция ${rank}, сложность ${difficulty}/100 — конкуренция стеной, не трогать сейчас.`,
        ),
        opportunity: demand - difficulty,
      };
    }
    const nearTop = rank <= NEAR_TOP_MAX;
    return {
      kw, move: 'push', bucket: 'pushNow',
      reason: r(
        `Rank ${rank}, difficulty ${difficulty}/100, demand ${demand}/100 — ${nearTop ? 'close, push to climb' : 'room to climb with metadata work'}.`,
        `Позиция ${rank}, сложность ${difficulty}/100, спрос ${demand}/100 — ${nearTop ? 'близко, дожимаем' : 'есть куда расти через метаданные'}.`,
      ),
      opportunity: 200 + demand - difficulty * 0.5 + (nearTop ? 100 : 0),
    };
  }

  // 3. Не ранжируется вовсе.
  if (difficulty >= DIFFICULTY_WALL) {
    return {
      kw, move: 'skip', bucket: 'longShots',
      reason: r(
        `Not ranking, difficulty ${difficulty}/100 — too contested to enter now.`,
        `Не в выдаче, сложность ${difficulty}/100 — войти сейчас слишком тяжело.`,
      ),
      opportunity: demand - difficulty - 20,
    };
  }
  // Высокий спрос + проходимая сложность + не ранжируемся = чистая возможность.
  const expandBoost = goal === 'expand' ? 60 : 0;
  return {
    kw, move: 'push', bucket: 'pushNow',
    reason: r(
      `Not ranking yet, demand ${demand}/100, difficulty only ${difficulty}/100 — open opportunity, add to metadata.`,
      `Ещё не в выдаче, спрос ${demand}/100, сложность всего ${difficulty}/100 — открытая возможность, добавь в метаданные.`,
    ),
    opportunity: 150 + demand - difficulty * 0.5 + expandBoost,
  };
}

// --- Сборка результата по правилам -----------------------------------------

export function buildRuleBasedInsights(
  job: DiscoveryJobState, opts: InsightsOptions = {},
): InsightsResult {
  const goal: Goal = opts.goal ?? 'rank_up';
  const ru = ruLang(opts.locale ?? job.country);
  const limit = Math.max(1, config.anthropic.maxKeywords);

  // Берём топ-N по спросу — на них и строим план.
  const pool = [...job.keywords]
    .sort((a, b) => b.volume - a.volume)
    .slice(0, limit);

  const classified = pool.map((kw) => classify(kw, goal, ru));
  classified.sort((a, b) => b.opportunity - a.opportunity);

  const quadrant: InsightQuadrant = { pushNow: [], quickWins: [], longShots: [], ignore: [] };
  const actions: InsightAction[] = classified.map((c, i) => {
    if (c.bucket) quadrant[c.bucket].push(c.kw.term);
    return {
      term: c.kw.term,
      move: c.move,
      currentRank: c.kw.rank,
      reason: c.reason,
      priority: i + 1,
    };
  });

  const pushCount = actions.filter((a) => a.move === 'push').length;
  const summary = ru
    ? `${quadrant.quickWins.length} быстрых побед (позиции 11–25), ${quadrant.pushNow.length} возможностей для роста, ${quadrant.longShots.length} ключей с конкуренцией стеной. Начни с ${pushCount} приоритетных правок сверху списка.`
    : `${quadrant.quickWins.length} quick wins (rank 11–25), ${quadrant.pushNow.length} growth opportunities, ${quadrant.longShots.length} walled-off keywords. Start with the top ${pushCount} prioritized edits.`;

  return {
    appId: job.appId,
    jobId: job.jobId,
    generatedAt: new Date().toISOString(),
    summary,
    actions,
    quadrant,
    meta: { model: 'rule-based', dataQuality: 'estimated', keywordsAnalyzed: pool.length },
  };
}

// --- LLM-путь (Anthropic Messages API, structured tool output) -------------

const SYSTEM_PROMPT = `You are an ASO (App Store Optimization) strategist. You prioritize keywords for an app along TWO independent axes:
- demand: how many users search the term (autocomplete-weighted popularity, 5-100). Higher = more traffic.
- difficulty: how hard it is to break into the top (strength of the top-10 apps, 5-100). Higher = harder.
"saturation" (how many apps compete) is supplementary context, NOT a third axis.

Decision rules (follow strictly; do not invent your own scale):
- demand < ${DEMAND_LOW}  -> move "skip", bucket "ignore" (too little traffic).
- rank 1-10               -> move "monitor" (already top, don't waste edits). EXCEPTION: when goal is "defend" and difficulty >= ${HIGH_DEMAND}, move "push" to hold the position.
- rank ${QUICK_WIN_MIN}-${QUICK_WIN_MAX}             -> move "push", HIGHEST priority (one step from top-10, best ROI).
- rank ${QUICK_WIN_MAX + 1}+ or not ranking, difficulty >= ${DIFFICULTY_WALL} -> move "skip", bucket "longShots" (wall of competition).
- rank ${QUICK_WIN_MAX + 1}+ or not ranking, difficulty < ${DIFFICULTY_WALL}, demand >= ${DEMAND_LOW} -> move "push", bucket "pushNow".

Buckets: quickWins (rank 11-25), pushNow (push opportunities not in top and not walled), longShots (high difficulty), ignore (low demand). Monitored keywords (already top-10) go in NO bucket.

Order "actions" by priority (1 = act first): quick wins first, then high-demand low-difficulty pushes.

Hard constraints:
- Use ONLY keywords from the provided list. Never invent keywords.
- NEVER reference reviews, ratings, or star counts — that data is not provided.
- Do NOT promise specific positions or percentage gains.
- Each reason must cite the actual rank/demand/difficulty numbers.
- Write summary and every reason in {{LANG}}.`;

interface LlmToolInput {
  summary?: unknown;
  actions?: unknown;
  quadrant?: unknown;
}

const INSIGHTS_TOOL = {
  name: 'emit_insights',
  description: 'Return the prioritized ASO keyword action plan.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: '1-2 sentence human summary.' },
      actions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            term: { type: 'string' },
            move: { type: 'string', enum: ['push', 'monitor', 'skip'] },
            currentRank: { type: ['integer', 'null'] },
            reason: { type: 'string' },
            priority: { type: 'integer' },
          },
          required: ['term', 'move', 'reason', 'priority'],
        },
      },
      quadrant: {
        type: 'object',
        properties: {
          pushNow: { type: 'array', items: { type: 'string' } },
          quickWins: { type: 'array', items: { type: 'string' } },
          longShots: { type: 'array', items: { type: 'string' } },
          ignore: { type: 'array', items: { type: 'string' } },
        },
        required: ['pushNow', 'quickWins', 'longShots', 'ignore'],
      },
    },
    required: ['summary', 'actions', 'quadrant'],
  },
} as const;

function compactKeywords(keywords: UrlKeyword[]): string {
  // Узкий JSON: только то, что нужно для суждения. Экономит токены.
  return JSON.stringify(
    keywords.map((k) => ({
      term: k.term,
      rank: k.rank,
      demand: k.volume,
      saturation: k.saturation,
      difficulty: k.difficulty,
    })),
  );
}

function coerceMove(v: unknown): Move {
  return v === 'push' || v === 'monitor' || v === 'skip' ? v : 'monitor';
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Валидация и нормализация выхода LLM в строгий контракт. Бросает при мусоре. */
function normalizeLlmOutput(
  input: LlmToolInput, job: DiscoveryJobState, validTerms: Set<string>, model: string, analyzed: number,
): InsightsResult {
  if (typeof input.summary !== 'string' || !Array.isArray(input.actions)) {
    throw new Error('LLM output missing summary/actions');
  }
  const rankByTerm = new Map(job.keywords.map((k) => [k.term, k.rank]));
  const actions: InsightAction[] = (input.actions as unknown[])
    .map((raw): InsightAction | null => {
      const a = raw as Record<string, unknown>;
      const term = typeof a.term === 'string' ? a.term : '';
      if (!validTerms.has(term)) return null; // защита от выдуманных ключей
      return {
        term,
        move: coerceMove(a.move),
        currentRank: rankByTerm.get(term) ?? null, // ранк из данных, не от модели
        reason: typeof a.reason === 'string' ? a.reason : '',
        priority: Number.isFinite(a.priority as number) ? Number(a.priority) : 999,
      };
    })
    .filter((a): a is InsightAction => a !== null)
    .sort((x, y) => x.priority - y.priority)
    .map((a, i) => ({ ...a, priority: i + 1 }));

  if (actions.length === 0) throw new Error('LLM produced no valid actions');

  const q = (input.quadrant ?? {}) as Record<string, unknown>;
  const filterValid = (arr: string[]) => arr.filter((t) => validTerms.has(t));
  const quadrant: InsightQuadrant = {
    pushNow: filterValid(asStringArray(q.pushNow)),
    quickWins: filterValid(asStringArray(q.quickWins)),
    longShots: filterValid(asStringArray(q.longShots)),
    ignore: filterValid(asStringArray(q.ignore)),
  };

  return {
    appId: job.appId,
    jobId: job.jobId,
    generatedAt: new Date().toISOString(),
    summary: input.summary,
    actions,
    quadrant,
    meta: { model, dataQuality: 'estimated', keywordsAnalyzed: analyzed },
  };
}

async function callAnthropic(
  job: DiscoveryJobState, pool: UrlKeyword[], opts: InsightsOptions,
): Promise<InsightsResult> {
  const goal: Goal = opts.goal ?? 'rank_up';
  const ru = ruLang(opts.locale ?? job.country);
  const system = SYSTEM_PROMPT.replace('{{LANG}}', ru ? 'Russian' : 'English');

  const userContent = [
    `App: ${job.appTitle} (${job.platform}, ${job.country.toUpperCase()})`,
    `Goal: ${goal}`,
    `Keywords (JSON): ${compactKeywords(pool)}`,
  ].join('\n');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.anthropic.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.anthropic.model,
        max_tokens: 4096,
        temperature: 0.2,
        system,
        tools: [INSIGHTS_TOOL],
        tool_choice: { type: 'tool', name: INSIGHTS_TOOL.name },
        messages: [{ role: 'user', content: userContent }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      content?: Array<{ type: string; name?: string; input?: LlmToolInput }>;
    };
    const block = (data.content ?? []).find(
      (b) => b.type === 'tool_use' && b.name === INSIGHTS_TOOL.name,
    );
    if (!block?.input) throw new Error('No tool_use block in response');
    const validTerms = new Set(pool.map((k) => k.term));
    return normalizeLlmOutput(block.input, job, validTerms, config.anthropic.model, pool.length);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Главная точка входа. Пытается LLM, при любой проблеме — детерминированный
 * фолбэк. Контракт результата одинаков в обоих случаях.
 */
export async function generateInsights(
  job: DiscoveryJobState, opts: InsightsOptions = {},
): Promise<InsightsResult> {
  if (job.status !== 'done') {
    throw new Error('Анализ ещё не завершён — инсайты доступны после готовой джобы');
  }
  if (!job.keywords.length) {
    throw new Error('В джобе нет ключей для анализа');
  }

  const limit = Math.max(1, config.anthropic.maxKeywords);
  const pool = [...job.keywords].sort((a, b) => b.volume - a.volume).slice(0, limit);

  if (config.anthropic.apiKey) {
    try {
      return await callAnthropic(job, pool, opts);
    } catch {
      // Модель недоступна/вернула мусор — не роняем продукт, отдаём правила.
    }
  }
  return buildRuleBasedInsights(job, opts);
}
