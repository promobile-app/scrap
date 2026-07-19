// Платёжный слой: интерфейс провайдера + stub-реализация.
//
// Зачем интерфейс: подключение реального провайдера (Paddle / LemonSqueezy /
// Stripe) не должно трогать маршруты и расширение. Меняется только реализация
// PaymentProvider + добавляется webhook-роут провайдера, который вызывает
// те же activateSubscription()/markPaymentStatus().
//
// Безопасность stub: страница checkout открывается в новой вкладке БЕЗ
// Bearer-токена, поэтому подтверждение защищено одноразовым подписанным
// confirm-токеном (JWT, purpose='pay-confirm', TTL 1 час), который выдаётся
// только владельцу платежа при создании checkout. Раньше /payment/confirm
// принимал голый paymentId — любой мог подтвердить чужой платёж.
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { notify } from '../notify.js';

export interface CheckoutSession {
  paymentId: number;
  /** Относительный или абсолютный URL страницы оплаты. */
  checkoutUrl: string;
  amountCents: number;
  currency: string;
  kind: 'subscription' | 'report';
}

export interface PaymentProvider {
  readonly name: string;
  /**
   * Создать checkout-сессию подписки. jobId опционален — это job, из которой
   * пользователь пришёл на пейволл (после оплаты помечается paid для истории).
   */
  createSubscriptionCheckout(userId: number, jobId?: number | null): Promise<CheckoutSession>;
}

// --- Общие операции (используются и stub'ом, и будущими webhook'ами) --------

/** Активировать/продлить подписку пользователя на periodDays от max(now, конец). */
export async function activateSubscription(
  userId: number,
  provider: string,
  externalId?: string | null,
): Promise<void> {
  await query(
    `INSERT INTO subscriptions (user_id, plan, status, provider, external_id, current_period_end)
     VALUES ($1, 'pro', 'active', $2, $3, now() + make_interval(days => $4))
     ON CONFLICT (user_id) DO UPDATE SET
       status = 'active',
       provider = EXCLUDED.provider,
       external_id = COALESCE(EXCLUDED.external_id, subscriptions.external_id),
       current_period_end =
         GREATEST(COALESCE(subscriptions.current_period_end, now()), now())
           + make_interval(days => $4),
       updated_at = now()`,
    [userId, provider, externalId ?? null, config.subscription.periodDays],
  );
}

export interface SubscriptionState {
  status: string;
  currentPeriodEnd: string | null;
  active: boolean;
}

/** Текущее состояние подписки пользователя (null — подписки не было). */
export async function getSubscription(userId: number): Promise<SubscriptionState | null> {
  const rows = await query<{ status: string; current_period_end: string | null }>(
    'SELECT status, current_period_end FROM subscriptions WHERE user_id = $1',
    [userId],
  );
  const s = rows[0];
  if (!s) return null;
  const active =
    s.status === 'active' &&
    s.current_period_end != null &&
    new Date(s.current_period_end).getTime() > Date.now();
  return { status: s.status, currentPeriodEnd: s.current_period_end, active };
}

// --- Confirm-токен (stub) ----------------------------------------------------

interface ConfirmPayload {
  purpose: 'pay-confirm';
  pid: number;
}

export function signConfirmToken(paymentId: number): string {
  const payload: ConfirmPayload = { purpose: 'pay-confirm', pid: paymentId };
  return jwt.sign(payload, config.jwtSecret, { expiresIn: '1h' });
}

/** Проверка confirm-токена: вернёт paymentId или null. */
export function verifyConfirmToken(token: string): number | null {
  try {
    const p = jwt.verify(token, config.jwtSecret) as Partial<ConfirmPayload>;
    return p.purpose === 'pay-confirm' && typeof p.pid === 'number' ? p.pid : null;
  } catch {
    return null;
  }
}

// --- Stub-провайдер ----------------------------------------------------------

class StubProvider implements PaymentProvider {
  readonly name = 'stub';

  async createSubscriptionCheckout(
    userId: number,
    jobId?: number | null,
  ): Promise<CheckoutSession> {
    const { priceCents, currency } = config.subscription;
    const rows = await query<{ id: number }>(
      `INSERT INTO payments (user_id, job_id, amount_cents, currency, status, provider, kind)
       VALUES ($1, $2, $3, $4, 'pending', 'stub', 'subscription') RETURNING id`,
      [userId, jobId ?? null, priceCents, currency],
    );
    const paymentId = rows[0]!.id;
    const token = signConfirmToken(paymentId);
    return {
      paymentId,
      checkoutUrl: `/payment/checkout/${paymentId}?t=${encodeURIComponent(token)}`,
      amountCents: priceCents,
      currency,
      kind: 'subscription',
    };
  }
}

/**
 * Подтверждение stub-платежа (вызывается страницей checkout с confirm-токеном).
 * Для реального провайдера тот же код вызовет webhook-обработчик.
 * Возвращает итоговый статус платежа.
 */
export async function confirmStubPayment(
  paymentId: number,
  outcome: 'success' | 'failed',
): Promise<{ status: string } | null> {
  const rows = await query<{
    id: number; user_id: number; job_id: number | null; status: string; kind: string;
  }>(
    'SELECT id, user_id, job_id, status, kind FROM payments WHERE id = $1',
    [paymentId],
  );
  const p = rows[0];
  if (!p) return null;
  if (p.status !== 'pending') return { status: p.status }; // идемпотентность
  await query(
    'UPDATE payments SET status = $1, updated_at = now() WHERE id = $2',
    [outcome, paymentId],
  );
  if (outcome === 'success') {
    if (p.kind === 'subscription') {
      await activateSubscription(p.user_id, 'stub', String(paymentId));
    }
    // Job, из которой пришли — помечаем оплаченной (история/совместимость).
    if (p.job_id) {
      await query('UPDATE discovery_jobs SET paid = TRUE WHERE id = $1', [p.job_id]);
    }
    notify(`💰 Оплата #${paymentId}: user ${p.user_id}, ${p.kind}`, 'payment-success');
  }
  return { status: outcome };
}

/** Активный платёжный провайдер (пока только stub). */
export const paymentProvider: PaymentProvider = new StubProvider();
