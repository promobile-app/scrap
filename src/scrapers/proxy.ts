// Общий прокси-слой: снимает ограничение «один IP» и для Apple (undici), и для
// Google Play (got внутри google-play-scraper). Без прокси всё работает как раньше.
//
// Конфиг через env:
//   PROXY_URLS=http://user:pass@host1:port,http://user:pass@host2:port   (пул, round-robin)
//   PROXY_URL=http://user:pass@host:port                                  (один прокси)
//
// Apple-запросы (native.ts/http.ts на undici) берут dispatcher = ProxyAgent.
// Google Play (got) получает requestOptions.agent = { https: HttpsProxyAgent }.

import { ProxyAgent } from 'undici';
import type { Dispatcher } from 'undici';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function parseList(): string[] {
  const raw = process.env.PROXY_URLS || process.env.PROXY_URL || '';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

const PROXY_URLS = parseList();

export function proxyEnabled(): boolean { return PROXY_URLS.length > 0; }
export function proxyCount(): number { return PROXY_URLS.length; }

// --- Apple (undici dispatcher) ---------------------------------------------
const undiciAgents: ProxyAgent[] = PROXY_URLS.map((u) => new ProxyAgent(u));
let uCursor = 0;

// Кулдаун прокси после сетевой ошибки: мёртвый прокси выбывает из ротации,
// а не мучает каждый следующий запрос 10-секундным connect-таймаутом.
const FAIL_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Длина кулдауна своя на площадку. Пять минут — это про мёртвый адрес у
 * Google. У Apple причина другая: адрес живой, просто исчерпал квоту на
 * поиск, и минуты ему хватает, чтобы снова начать отвечать. С пятиминутным
 * кулдауном один отказ уносил адрес из ротации так надолго, что пул стоял
 * тёмным почти всё время: 77 отказов за прогон давали 385 адрес-минут
 * простоя при 200 доступных.
 */
const COOLDOWN_MS: Record<ProxyScope, number> = {
  google: Number(process.env.PROXY_COOLDOWN_MS ?? FAIL_COOLDOWN_MS),
  apple: Number(process.env.APPLE_PROXY_COOLDOWN_MS ?? 60_000),
};

/**
 * Кулдаун считается ОТДЕЛЬНО по площадкам.
 *
 * Раньше карта была общей, и блокировка от Google (капча на batchexecute)
 * выводила адрес из ротации и для Apple. При активном обходе Play в кулдаун
 * уходил весь пул, nextDispatcher возвращал undefined, и запросы к Apple шли
 * напрямую с единственного egress-IP — оттуда и 429 сотнями. Адрес, которому
 * не рад Google, для Apple совершенно исправен.
 */
export type ProxyScope = 'apple' | 'google';

const failedUntil = new Map<string, number>();
const cooldownKey = (scope: ProxyScope, idx: number): string => `${scope}|${idx}`;

function indexOfAgent(d: Dispatcher | undefined): number {
  return d ? undiciAgents.indexOf(d as ProxyAgent) : -1;
}

function isAvailable(scope: ProxyScope, idx: number): boolean {
  return (failedUntil.get(cooldownKey(scope, idx)) ?? 0) <= Date.now();
}

/** Пометить прокси упавшим для площадки — он пропускается в её ротации. */
export function reportDispatcherFailure(
  d: Dispatcher | undefined, scope: ProxyScope = 'google',
): void {
  const idx = indexOfAgent(d);
  if (idx >= 0) failedUntil.set(cooldownKey(scope, idx), Date.now() + COOLDOWN_MS[scope]);
}

/** Сколько адресов сейчас в кулдауне по площадке — для /health. */
export function proxyCooldownCount(scope: ProxyScope): number {
  let n = 0;
  for (let i = 0; i < undiciAgents.length; i++) if (!isAvailable(scope, i)) n++;
  return n;
}

/**
 * Пул настроен, но целиком в кулдауне по площадке.
 *
 * Отличать это от «прокси не настроены» обязательно: во втором случае прямое
 * соединение — штатный режим, а в первом оно уводит весь трафик на
 * единственный egress-IP контейнера, и следующим Apple закрывает уже его.
 * Вызывающий код должен не ходить вовсе, а не ходить напрямую.
 */
export function poolExhausted(scope: ProxyScope = 'apple'): boolean {
  if (!undiciAgents.length) return false;
  return proxyCooldownCount(scope) >= undiciAgents.length;
}

/**
 * Round-robin ProxyAgent для undici (или undefined → прямое соединение).
 * Прокси в кулдауне пропускаются; если весь пул в кулдауне — идём напрямую.
 */
export function nextDispatcher(scope: ProxyScope = 'google'): Dispatcher | undefined {
  if (!undiciAgents.length) return undefined;
  for (let i = 0; i < undiciAgents.length; i++) {
    const idx = uCursor % undiciAgents.length;
    uCursor += 1;
    if (isAvailable(scope, idx)) return undiciAgents[idx]!;
  }
  return undefined;
}

/**
 * Стабильный прокси для «виртуального устройства» с номером slot.
 *
 * Для Apple важно не просто разложить нагрузку по адресам, а сохранить
 * связку «устройство ↔ адрес»: в запросе едет guid устройства, и когда один
 * guid ходит с двадцати адресов, а каждый адрес показывает восемнадцать
 * guid'ов, это выглядит ровно как то, чем является. Пин делает пару
 * устойчивой, а штраф канала при 429 автоматически становится штрафом
 * именно тому адресу, которому Apple сказал «хватит».
 */
export function dispatcherForSlot(
  slot: number, scope: ProxyScope = 'apple',
): Dispatcher | undefined {
  if (!undiciAgents.length) return undefined;
  const pinned = ((slot % undiciAgents.length) + undiciAgents.length) % undiciAgents.length;
  if (isAvailable(scope, pinned)) return undiciAgents[pinned]!;
  // Закреплённый адрес в кулдауне — берём любой живой, чтобы не идти напрямую.
  for (let i = 1; i < undiciAgents.length; i++) {
    const idx = (pinned + i) % undiciAgents.length;
    if (isAvailable(scope, idx)) return undiciAgents[idx]!;
  }
  return undefined;
}

// --- Google Play (got agent) -----------------------------------------------
// https-proxy-agent подгружаем лениво: если пакета ещё нет (до деплоя) — Google
// просто идёт напрямую, без падения сборки/рантайма.
let HpaCtor: unknown;
function getHpa(): (new (url: string) => unknown) | null {
  if (HpaCtor === undefined) {
    try {
      HpaCtor = (require('https-proxy-agent') as { HttpsProxyAgent: unknown }).HttpsProxyAgent;
    } catch {
      HpaCtor = null;
    }
  }
  return (HpaCtor as (new (url: string) => unknown) | null) ?? null;
}

let gotAgents: Array<{ https: unknown }> = [];
let gCursor = 0;

/** Round-robin got-agent для google-play-scraper (или undefined). */
export function nextGotAgent(): { https: unknown } | undefined {
  if (!PROXY_URLS.length) return undefined;
  const Hpa = getHpa();
  if (!Hpa) return undefined;
  if (gotAgents.length !== PROXY_URLS.length) {
    gotAgents = PROXY_URLS.map((u) => ({ https: new Hpa(u) }));
  }
  const a = gotAgents[gCursor % gotAgents.length]!;
  gCursor += 1;
  return a;
}

/** requestOptions для gplay.* с прокси (пустой объект, если прокси нет). */
export function gpRequestOptions(): { agent?: { https: unknown } } {
  const agent = nextGotAgent();
  return agent ? { agent } : {};
}
