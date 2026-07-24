import { gunzipSync } from 'node:zlib';
import { request } from 'undici';
import { nextDispatcher, reportDispatcherFailure } from '../proxy.js';

/**
 * HTTP-слой Finsky. Отдельный от scrapers/http.ts: там JSON/текст с ротацией
 * User-Agent, а здесь бинарный protobuf и жёстко заданный UA устройства —
 * подмена UA тут сразу ломает подпись клиента.
 *
 * Прокси берётся из общего пула (proxy.ts). Гео выдачи Play определяется
 * страной аккаунта И IP, поэтому для честных позиций по стране нужен прокси
 * этой страны — см. README пробника.
 */

export interface PlayResponse {
  statusCode: number;
  body: Buffer;
}

const TIMEOUT_MS = 30_000;

function maybeGunzip(buf: Buffer, encoding?: string): Buffer {
  if (encoding?.includes('gzip')) return gunzipSync(buf);
  // Play иногда отдаёт gzip без заголовка — проверяем магию 1f 8b.
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) return gunzipSync(buf);
  return buf;
}

async function send(
  url: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: Buffer | string },
): Promise<PlayResponse> {
  const dispatcher = nextDispatcher();
  try {
    const res = await request(url, {
      method: init.method,
      headers: { 'Accept-Encoding': 'gzip', ...init.headers },
      ...(init.body !== undefined ? { body: init.body } : {}),
      ...(dispatcher ? { dispatcher } : {}),
      headersTimeout: TIMEOUT_MS,
      bodyTimeout: TIMEOUT_MS,
    });
    const raw = Buffer.from(await res.body.arrayBuffer());
    const encoding = res.headers['content-encoding'];
    return {
      statusCode: res.statusCode,
      body: maybeGunzip(raw, Array.isArray(encoding) ? encoding[0] : encoding),
    };
  } catch (e) {
    reportDispatcherFailure(dispatcher);
    throw e;
  }
}

export async function playGet(
  url: string,
  headers: Record<string, string>,
  query: Record<string, string> = {},
): Promise<PlayResponse> {
  const full = new URL(url);
  for (const [k, v] of Object.entries(query)) full.searchParams.set(k, v);
  return send(full.toString(), { method: 'GET', headers });
}

export async function playPostForm(
  url: string,
  headers: Record<string, string>,
  params: Record<string, string>,
): Promise<PlayResponse> {
  const body = new URLSearchParams(params).toString();
  return send(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
}

/**
 * POST с protobuf-телом. `contentType: false` — как в апстриме: OkHttp там шлёт
 * тело без media type, и /fdfe/uploadDeviceConfig на явный x-protobuffer
 * отвечает 400. Для /checkin заголовок наоборот обязателен.
 */
export async function playPostProto(
  url: string,
  headers: Record<string, string>,
  body: Buffer,
  contentType: string | false = 'application/x-protobuffer',
): Promise<PlayResponse> {
  return send(url, {
    method: 'POST',
    headers: contentType ? { ...headers, 'Content-Type': contentType } : headers,
    body,
  });
}

/** Разбор ответа /auth: строки вида `Auth=...`, `Error=BadAuthentication`. */
export function parseAuthResponse(body: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of body.toString('utf8').split(/[\r\n]+/)) {
    const idx = line.indexOf('=');
    if (idx > 0) out.set(line.slice(0, idx), line.slice(idx + 1));
  }
  return out;
}
