// Email-дайджест изменений позиций — вызывается планировщиком после recheck.
//
// Логика: по каждому пользователю с включёнными алертами и не чаще раза в
// digestMinHours собираем значимые изменения по всем его отслеживаемым
// приложениям за окно 24ч. Есть изменения → одно письмо со всеми приложениями.
// Нет email-провайдера → пишем в лог (и это видно в /health).
import jwt from 'jsonwebtoken';
import { query } from '../db/pool.js';
import { config } from '../config.js';
import { sendEmail } from '../email.js';
import { notify } from '../notify.js';
import { computeChanges, type TermChange, type TrackedApp } from '../tracking/tracking.js';

interface UserRow { id: number; email: string }

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function unsubscribeUrl(userId: number): string {
  const t = jwt.sign({ purpose: 'alerts-unsub', uid: userId }, config.jwtSecret, {
    expiresIn: '90d',
  });
  return `${config.publicUrl}/ext/alerts/unsubscribe?t=${encodeURIComponent(t)}`;
}

export function verifyUnsubToken(token: string): number | null {
  try {
    const p = jwt.verify(token, config.jwtSecret) as { purpose?: string; uid?: number };
    return p.purpose === 'alerts-unsub' && typeof p.uid === 'number' ? p.uid : null;
  } catch {
    return null;
  }
}

function changeLine(c: TermChange): string {
  const rank = (r: number | null) => (r == null ? 'out' : `#${r}`);
  let badge = '';
  if (c.enteredTop10) badge = ' <b style="color:#12805c">entered Top 10</b>';
  else if (c.leftTop10) badge = ' <b style="color:#b42318">left Top 10</b>';
  const dir = c.delta != null && c.delta > 0 ? '▲' : '▼';
  const col = c.delta != null && c.delta > 0 ? '#12805c' : '#b42318';
  const move = c.delta != null && c.delta !== 0
    ? ` <span style="color:${col}">${dir}${Math.abs(c.delta)}</span>`
    : '';
  return `<tr>
    <td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(c.term)}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap">
      ${rank(c.prevRank)} → <b>${rank(c.currRank)}</b>${move}${badge}
    </td></tr>`;
}

function digestHtml(
  apps: Array<{ app: TrackedApp; changes: TermChange[] }>,
  userId: number,
): string {
  const blocks = apps.map(({ app, changes }) => {
    const store = app.platform === 'android' ? 'Google Play' : 'App Store';
    return `<h3 style="margin:20px 0 6px;font-size:15px">
        ${esc(app.appTitle ?? app.appId)}
        <span style="color:#888;font-weight:400"> · ${store} · ${app.country.toUpperCase()}</span>
      </h3>
      <table style="border-collapse:collapse;width:100%;font-size:13px">${changes.map(changeLine).join('')}</table>`;
  }).join('');
  return `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;color:#222">
    <h2 style="font-size:18px;margin:0 0 4px">Keyword movements — last 24h</h2>
    <p style="color:#888;font-size:12px;margin:0 0 8px">RankRadar tracks your apps every 3 hours.</p>
    ${blocks}
    <p style="color:#aaa;font-size:11px;margin-top:24px">
      You get this because keyword tracking is on for these apps.
      <a href="${unsubscribeUrl(userId)}" style="color:#888">Turn off email alerts</a>
    </p></div>`;
}

/** Прогон дайджестов. Возвращает число отправленных писем. */
export async function sendDigests(): Promise<number> {
  // Пользователи с включёнными алертами и «остывшим» таймером дайджеста.
  const users = await query<UserRow>(
    `SELECT DISTINCT u.id, u.email
     FROM users u JOIN tracked_apps t ON t.user_id = u.id
     WHERE t.alerts_enabled = TRUE
       AND (t.last_digest_at IS NULL
            OR t.last_digest_at < now() - ($1 || ' hours')::interval)`,
    [String(config.tracking.digestMinHours)],
  );
  let sent = 0;
  for (const u of users) {
    try {
      const apps = await query<TrackedApp>(
        `SELECT id, user_id AS "userId", platform, app_id AS "appId",
                app_title AS "appTitle", country, terms,
                alerts_enabled AS "alertsEnabled",
                last_digest_at AS "lastDigestAt", created_at AS "createdAt"
         FROM tracked_apps WHERE user_id = $1 AND alerts_enabled = TRUE`,
        [u.id],
      );
      const withChanges: Array<{ app: TrackedApp; changes: TermChange[] }> = [];
      for (const app of apps) {
        const changes = (await computeChanges(
          app.platform, app.appId, app.country, app.terms as string[], 24,
        )).filter((c) => c.significant);
        if (changes.length) withChanges.push({ app, changes });
      }
      if (!withChanges.length) continue;

      const total = withChanges.reduce((s, a) => s + a.changes.length, 0);
      const ok = await sendEmail(
        u.email,
        `RankRadar: ${total} keyword movement${total === 1 ? '' : 's'} in your tracked apps`,
        digestHtml(withChanges, u.id),
      );
      // Таймер двигаем и при выключенном email-провайдере — иначе лог зальёт
      // одним и тем же дайджестом каждые 3 часа.
      await query(
        'UPDATE tracked_apps SET last_digest_at = now() WHERE user_id = $1',
        [u.id],
      );
      if (ok) sent++;
    } catch (e) {
      console.error(`[digest] user ${u.id}:`, e instanceof Error ? e.message : e);
    }
  }
  if (sent) notify(`📬 Дайджесты отправлены: ${sent}`, 'digest-sent');
  console.log(`[digest] отправлено писем: ${sent}/${users.length} кандидатов`);
  return sent;
}
