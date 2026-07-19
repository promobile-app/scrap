// Отправка email через Resend HTTP API (https://resend.com) — без новых
// зависимостей, обычный POST через undici. Без RESEND_API_KEY — no-op с логом,
// чтобы локальная разработка и тесты не требовали аккаунта.
import { request } from 'undici';
import { config } from './config.js';

export function emailEnabled(): boolean {
  return Boolean(config.email.resendApiKey);
}

/** Отправить письмо. Возвращает true при успехе; никогда не бросает. */
export async function sendEmail(
  to: string,
  subject: string,
  html: string,
): Promise<boolean> {
  if (!emailEnabled()) {
    console.log(`[email] (выключен) to=${to} subject="${subject}"`);
    return false;
  }
  try {
    const res = await request('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.email.resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: config.email.from, to: [to], subject, html }),
      headersTimeout: 15_000,
      bodyTimeout: 15_000,
    });
    const text = await res.body.text();
    if (res.statusCode >= 400) {
      console.error(`[email] Resend ${res.statusCode}: ${text.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error('[email] send failed:', e instanceof Error ? e.message : e);
    return false;
  }
}
