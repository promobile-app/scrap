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

const SYSTEM = `You filter App Store keyword candidates for relevance to ONE specific app.
Keep a keyword only if a user searching for this app, or for an app in its category/use-case, would plausibly type it.
DROP keywords that belong to an unrelated product, brand, or vertical — even when they share a word with the app (e.g. for a video-streaming app: drop "channels dvr", "community bank", "device monitor"; keep "watch videos", "music videos", "live tv").
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
    // Защита от «модель вернула почти пусто» — не вычищаем весь список вслепую.
    if (keep.size === 0) return null;
    if (terms.length >= 10 && keep.size < terms.length * 0.1) return null;
    return keep;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
