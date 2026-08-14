import { buildAuth, isAuthValid } from './auth.js';
import type { AuthState } from './headers.js';

/**
 * Общая сессия Finsky для долгоживущего процесса (API-сервер).
 *
 * buildAuth регистрирует устройство и обменивает токены — это несколько
 * запросов к Google, делать их на каждый вызов нельзя. Держим одну сессию на
 * локаль и переподнимаем её только когда Play перестал её принимать.
 *
 * Конкурентные вызовы разделяют один промис: без этого десять параллельных
 * запросов на холодном старте устроят десять регистраций устройства подряд.
 */

const sessions = new Map<string, Promise<AuthState>>();

function localeKey(locale?: string): string {
  return locale ?? process.env.FINSKY_LOCALE ?? 'en_US';
}

export function finskyConfigured(): boolean {
  return Boolean(process.env.FINSKY_EMAIL && process.env.FINSKY_AAS_TOKEN);
}

/** Сессия из кэша; при первом обращении поднимается и переиспользуется. */
export async function finskySession(locale?: string): Promise<AuthState> {
  const key = localeKey(locale);
  let pending = sessions.get(key);

  if (pending) {
    try {
      const auth = await pending;
      if (await isAuthValid(auth)) return auth;
    } catch {
      // упавшую сессию не кэшируем — ниже поднимем заново
    }
    sessions.delete(key);
  }

  pending = buildAuth({ locale: key });
  sessions.set(key, pending);

  try {
    return await pending;
  } catch (e) {
    sessions.delete(key);
    throw e;
  }
}
