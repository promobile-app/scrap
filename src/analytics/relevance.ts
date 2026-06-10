// LLM-проход релевантности кандидатов. Эвристика coreRelevant ловит явный
// off-topic по токенам, но пропускает «реальный запрос с общим словом про другой
// продукт» (например "channels dvr" для YouTube — делит токен "channels").
// Здесь модель, которая знает, что такое YouTube, отсекает такие запросы.
//
// Работает только при заданном ANTHROPIC_API_KEY. Без ключа/при сбое возвращает
// null — вызывающий код тогда остаётся на эвристике, продукт не падает.

import { config } from '../config.js';

export interface RelevanceAppContext {
  title: string;
  genre: string;
  description?: string;
}

const RELEVANCE_TOOL = {
  name: 'emit_relevant_keywords',
  description: 'Return the subset of candidate keywords that are relevant to the app.',
  input_schema: {
    type: 'object',
    properties: {
      relevant: {
        type: 'array',
        items: { type: 'string' },
        description: 'Keywords (verbatim from the input list) a user looking for THIS app or its category/use-case would plausibly search.',
      },
    },
    required: ['relevant'],
  },
} as const;

const SYSTEM = `You filter app store keyword candidates to keep only ones that DESCRIBE one specific app — what it IS or DOES — not the proper names of OTHER apps.

KEEP: generic, descriptive, and category/use-case keywords a user would type to find this kind of app.
  e.g. for Brawl Stars: "battle royale", "3v3 shooter", "multiplayer games", "gem grab", "moba".
DROP: the proper name or brand of a DIFFERENT app, game, studio, or company — even in the same category.
  e.g. for Brawl Stars: drop "zooba", "fortnite", "clash royale", "pubg mobile", "supercell" competitors' brands.
DROP: keywords from an unrelated product or vertical that merely share a word (e.g. for a video app: drop "channels dvr", "community bank").
KEEP the app's OWN brand and its own feature names.

Rule of thumb: if the keyword is the NAME of another product, drop it; if it describes a feature, genre, or use-case, keep it.
Return ONLY keywords copied verbatim from the provided list. Never invent or modify keywords.`;

/**
 * Возвращает множество релевантных терминов (lowercase) или null, если LLM
 * недоступен/ответил мусором/подозрительно пусто (тогда фильтрацию пропускаем).
 */
export async function llmRelevantTerms(
  app: RelevanceAppContext, terms: string[],
): Promise<Set<string> | null> {
  if (!config.anthropic.apiKey || terms.length === 0) return null;

  const user = [
    `App: ${app.title}`,
    `Category: ${app.genre}`,
    app.description ? `Description: ${app.description.slice(0, 1200)}` : '',
    `Candidate keywords (JSON array): ${JSON.stringify(terms)}`,
  ].filter(Boolean).join('\n');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
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
        temperature: 0,
        system: SYSTEM,
        tools: [RELEVANCE_TOOL],
        tool_choice: { type: 'tool', name: RELEVANCE_TOOL.name },
        messages: [{ role: 'user', content: user }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      content?: Array<{ type: string; name?: string; input?: { relevant?: unknown } }>;
    };
    const block = (data.content ?? []).find(
      (b) => b.type === 'tool_use' && b.name === RELEVANCE_TOOL.name,
    );
    const rel = block?.input?.relevant;
    if (!Array.isArray(rel)) return null;

    const inputSet = new Set(terms.map((t) => t.toLowerCase()));
    const keep = new Set<string>();
    for (const r of rel) {
      if (typeof r === 'string' && inputSet.has(r.toLowerCase())) keep.add(r.toLowerCase());
    }
    // Защита только от явного сбоя «модель вернула пусто». РАНЬШЕ тут был ещё
    // относительный порог (bail при <10% оставленных) — но для приложений в
    // насыщенной нише (игры) список кандидатов на 80-90% состоит из брендов
    // конкурентов, и LLM ЗАКОННО оставляет мало. Тот порог ошибочно принимал
    // это за сбой и отключал фильтр → бренды конкурентов (zooba, fortnite)
    // проходили. Теперь доверяем модели, пока она вернула хоть что-то осмысленное.
    if (keep.size === 0) return null;
    return keep;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
