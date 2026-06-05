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

/** Round-robin ProxyAgent для undici (или undefined → прямое соединение). */
export function nextDispatcher(): Dispatcher | undefined {
  if (!undiciAgents.length) return undefined;
  const a = undiciAgents[uCursor % undiciAgents.length]!;
  uCursor += 1;
  return a;
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
