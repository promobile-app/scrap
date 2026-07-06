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
const failedUntil = new Map<Dispatcher, number>();

/** Пометить прокси упавшим — он пропускается в ротации на время кулдауна. */
export function reportDispatcherFailure(d: Dispatcher | undefined): void {
  if (d) failedUntil.set(d, Date.now() + FAIL_COOLDOWN_MS);
}

/**
 * Round-robin ProxyAgent для undici (или undefined → прямое соединение).
 * Прокси в кулдауне пропускаются; если весь пул в кулдауне — идём напрямую.
 */
export function nextDispatcher(): Dispatcher | undefined {
  if (!undiciAgents.length) return undefined;
  for (let i = 0; i < undiciAgents.length; i++) {
    const a = undiciAgents[uCursor % undiciAgents.length]!;
    uCursor += 1;
    if ((failedUntil.get(a) ?? 0) <= Date.now()) return a;
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
