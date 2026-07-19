// Операционные алерты в Telegram: протухшая ASA-сессия, оплаты, критические
// ошибки. Без настроенных TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID тихо no-op —
// сервис работает как раньше, всё уходит только в лог.
//
// Настройка: создать бота у @BotFather → TELEGRAM_BOT_TOKEN; написать боту
// любое сообщение и взять chat.id из getUpdates → TELEGRAM_CHAT_ID.
import { request } from 'undici';
import { config } from './config.js';

const MIN_INTERVAL_MS = 60_000; // антиспам: не чаще раза в минуту на один ключ

const lastSentAt = new Map<string, number>();

export function notifyEnabled(): boolean {
  return Boolean(config.telegram.botToken && config.telegram.chatId);
}

/**
 * Отправить алерт. dedupeKey — одинаковые алерты (например, каждая деградация
 * ASA) схлопываются и шлются не чаще раза в минуту. Никогда не бросает —
 * алертинг не должен ронять основную работу.
 */
export async function notify(text: string, dedupeKey?: string): Promise<void> {
  if (!notifyEnabled()) return;
  const key = dedupeKey ?? text.slice(0, 64);
  const now = Date.now();
  if (now - (lastSentAt.get(key) ?? 0) < MIN_INTERVAL_MS) return;
  lastSentAt.set(key, now);
  try {
    await request(
      `https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: config.telegram.chatId,
          text: `[RankRadar] ${text}`,
          disable_web_page_preview: true,
        }),
        headersTimeout: 10_000,
        bodyTimeout: 10_000,
      },
    );
  } catch (e) {
    console.error('[notify] telegram send failed:', e instanceof Error ? e.message : e);
  }
}
