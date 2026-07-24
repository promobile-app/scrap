import { readFileSync, writeFileSync } from 'node:fs';
import { loadDevice, DEFAULT_DEVICE, type DeviceProfile } from './device.js';
import { authHeaders, defaultHeaders, type AuthState } from './headers.js';
import { parseAuthResponse, playGet, playPostForm, playPostProto } from './http.js';
import { decodeProto, encodeProto } from './proto.js';

/**
 * Авторизация клиента Play. Порт GooglePlayApi.kt + ParamProvider.kt из
 * AuroraOSS/gplayapi (GPL-3.0-or-later).
 *
 * Последовательность (та же, что у AuthHelper.build):
 *   1. /checkin           — регистрирует устройство, отдаёт androidId (gsfId)
 *   2. /fdfe/uploadDeviceConfig — привязывает конфиг, отдаёт deviceConfigToken
 *   3. /auth              — меняет aas_token на токен сервиса googleplay
 *
 * ToS сознательно НЕ принимаем (в апстриме этот вызов тоже закомментирован):
 * acceptTos добавляет устройство в аккаунт пользователя.
 *
 * aas_token добывается вне этого кода: логин в Google руками, обмен
 * oauth_token из EmbeddedSetup. Здесь он приходит готовым через env.
 */

const URL_BASE = 'https://android.clients.google.com';
const URL_CHECK_IN = `${URL_BASE}/checkin`;
const URL_AUTH = `${URL_BASE}/auth`;
const URL_FDFE = `${URL_BASE}/fdfe`;
const URL_UPLOAD_DEVICE_CONFIG = `${URL_FDFE}/uploadDeviceConfig`;

const CALLER_SIG = '38918a453d07199354f8b19af05ec6562ced5788';
const GOOGLE_PLAY_SERVICE = 'oauth2:https://www.googleapis.com/auth/googleplay';

// Токен сервиса живёт ~1 час; обновляем заранее, чтобы не ловить 401 в середине
// обхода страниц выдачи.
const TOKEN_TTL_MS = 50 * 60 * 1000;

interface CachedState {
  email: string;
  deviceName: string;
  locale: string;
  gsfId: string;
  consistencyToken: string;
  deviceConfigToken: string;
  authToken: string;
  authTokenAt: number;
}

const STATE_PATH = process.env.FINSKY_STATE_PATH ?? './.finsky-state.json';

function readState(): CachedState | null {
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8')) as CachedState;
  } catch {
    return null;
  }
}

function writeState(state: CachedState): void {
  try {
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (e) {
    console.warn(`[finsky] не смог сохранить ${STATE_PATH}: ${(e as Error).message}`);
  }
}

/** Параметры /auth, общие для всех сервисов. */
function defaultAuthParams(
  email: string,
  device: DeviceProfile,
  locale: string,
  gsfId: string,
): Record<string, string> {
  const [lang = 'en', country = 'US'] = locale.split('_');
  const params: Record<string, string> = {
    sdk_version: String(device.sdkVersion),
    Email: email,
    google_play_services_version: String(device.playServicesVersion),
    device_country: country.toLowerCase(),
    lang: lang.toLowerCase(),
    callerSig: CALLER_SIG,
  };
  if (gsfId) params.androidId = gsfId;
  return params;
}

/** Регистрация устройства: androidId в ответе и есть gsfId (в hex). */
async function checkin(
  device: DeviceProfile,
  locale: string,
): Promise<{ gsfId: string; consistencyToken: string }> {
  const body = await encodeProto('AndroidCheckinRequest', device.checkinRequest(locale));
  const res = await playPostProto(
    URL_CHECK_IN,
    { ...authHeaders(device), Host: 'android.clients.google.com' },
    body,
  );
  if (res.statusCode !== 200) {
    throw new Error(`checkin: HTTP ${res.statusCode} ${res.body.toString('utf8').slice(0, 200)}`);
  }
  const decoded = await decodeProto<{ androidId?: string; deviceCheckinConsistencyToken?: string }>(
    'AndroidCheckinResponse',
    res.body,
  );
  if (!decoded.androidId || decoded.androidId === '0') {
    throw new Error('checkin: сервер не вернул androidId');
  }
  return {
    // longs: String в decodeProto -> десятичная строка; gsfId нужен в hex.
    gsfId: BigInt(decoded.androidId).toString(16),
    consistencyToken: decoded.deviceCheckinConsistencyToken ?? '',
  };
}

/** aas_token -> токен сервиса googleplay. */
async function generatePlayToken(
  email: string,
  aasToken: string,
  device: DeviceProfile,
  locale: string,
  gsfId: string,
): Promise<string> {
  const params: Record<string, string> = {
    ...defaultAuthParams(email, device, locale, gsfId),
    app: 'com.android.vending',
    client_sig: CALLER_SIG,
    callerPkg: 'com.google.android.gms',
    Token: aasToken,
    oauth2_foreground: '1',
    token_request_options: 'CAA4AVAB',
    check_email: '1',
    system_partition: '1',
    droidguard_results: 'null',
    service: GOOGLE_PLAY_SERVICE,
  };
  const res = await playPostForm(
    URL_AUTH,
    { ...authHeaders(device, gsfId), app: 'com.google.android.gms' },
    params,
  );
  const parsed = parseAuthResponse(res.body);
  const token = parsed.get('Auth');
  if (!token) {
    const error = parsed.get('Error') ?? `HTTP ${res.statusCode}`;
    throw new Error(`/auth не отдал токен: ${error}`);
  }
  return token;
}

/**
 * oauth_token из браузерного логина -> долгоживущий aas_token.
 *
 * oauth_token берётся вручную: логин в https://accounts.google.com/EmbeddedSetup,
 * затем значение cookie `oauth_token` (начинается с `oauth2_4/`). Токен
 * одноразовый и живёт минуты — обменивать сразу. Порт generateAASToken +
 * ParamProvider.getAASTokenParams.
 *
 * ВАЖНО: aas_token привязан к androidId, с которым его меняли. gsfId поэтому
 * сохраняется в state ЗДЕСЬ же — иначе следующий запуск сделает новый checkin,
 * получит другой androidId, и /auth ответит BadAuthentication.
 */
export async function exchangeOAuthForAas(
  email: string,
  oauthToken: string,
  opts: { deviceName?: string; locale?: string } = {},
): Promise<{ token: string; field: string; keys: string[] }> {
  const deviceName = opts.deviceName ?? process.env.FINSKY_DEVICE ?? DEFAULT_DEVICE;
  const device = loadDevice(deviceName);
  const locale = opts.locale ?? process.env.FINSKY_LOCALE ?? 'en_US';
  const cached = readState();
  const reusable = cached?.email === email && cached.deviceName === deviceName && cached.gsfId;
  const checkedIn = reusable
    ? { gsfId: cached.gsfId, consistencyToken: cached.consistencyToken }
    : await checkin(device, locale);
  const gsfId = checkedIn.gsfId;

  writeState({
    email,
    deviceName,
    locale,
    gsfId,
    consistencyToken: checkedIn.consistencyToken,
    deviceConfigToken: reusable ? cached.deviceConfigToken : '',
    authToken: '',
    authTokenAt: 0,
  });

  const params: Record<string, string> = {
    ...defaultAuthParams(email, device, locale, gsfId),
    service: 'ac2dm',
    add_account: '1',
    get_accountid: '1',
    ACCESS_TOKEN: '1',
    callerPkg: 'com.google.android.gms',
    Token: oauthToken,
    droidguard_results: 'null',
  };
  const res = await playPostForm(
    URL_AUTH,
    { ...authHeaders(device, gsfId), app: 'com.android.vending' },
    params,
  );
  const parsed = parseAuthResponse(res.body);
  // Мастер-токен приходит в `Token=`; `Auth=` — это уже короткоживущий токен
  // под сервис ac2dm, и попытка обменять его на токен googleplay даёт
  // BadAuthentication. Апстрим Aurora читает `Auth`, gpapi — `Token`; берём
  // `Token`, если он есть, иначе откатываемся на `Auth`.
  const field = parsed.has('Token') ? 'Token' : 'Auth';
  const token = parsed.get(field);
  if (!token) {
    const error = parsed.get('Error') ?? `HTTP ${res.statusCode}`;
    throw new Error(`обмен oauth_token не удался: ${error}`);
  }
  return { token, field, keys: [...parsed.keys()] };
}

/** Привязка конфигурации устройства; ответ — X-DFE-Device-Config-Token. */
async function uploadDeviceConfig(auth: AuthState): Promise<string> {
  const body = await encodeProto('UploadDeviceConfigRequest', {
    deviceConfiguration: auth.device.deviceConfiguration(),
  });
  // contentType: false — апстрим шлёт тело без media type (см. playPostProto).
  const res = await playPostProto(URL_UPLOAD_DEVICE_CONFIG, defaultHeaders(auth), body, false);
  if (res.statusCode !== 200) {
    throw new Error(`uploadDeviceConfig: HTTP ${res.statusCode}`);
  }
  const decoded = await decodeProto<{
    payload?: { uploadDeviceConfigResponse?: { uploadDeviceConfigToken?: string } };
  }>('ResponseWrapper', res.body);
  return decoded.payload?.uploadDeviceConfigResponse?.uploadDeviceConfigToken ?? '';
}

/**
 * /fdfe/toc — состояние витрины для устройства. Пока ToS не приняты, поле
 * tosToken непустое, а выдача поиска приходит урезанной (у нас: 5 карточек
 * вместо ~20 и пустая searchList-страница).
 */
async function toc(auth: AuthState): Promise<{ tosToken: string; cookie: string }> {
  const res = await playGet(`${URL_FDFE}/toc`, defaultHeaders(auth));
  if (res.statusCode !== 200) throw new Error(`toc: HTTP ${res.statusCode}`);
  const decoded = await decodeProto<{
    payload?: { tocResponse?: { tosToken?: string; cookie?: string; tosContent?: string } };
  }>('ResponseWrapper', res.body);
  return {
    tosToken: decoded.payload?.tocResponse?.tosToken ?? '',
    cookie: decoded.payload?.tocResponse?.cookie ?? '',
  };
}

/**
 * Принятие Play ToS для этого устройства. ДЕЙСТВИЕ В АККАУНТЕ ПОЛЬЗОВАТЕЛЯ:
 * устройство становится «настоящим» для Google Play. Поэтому шаг выключен по
 * умолчанию и включается явно — buildAuth({ acceptTos: true }) или
 * FINSKY_ACCEPT_TOS=1. В апстриме Aurora этот вызов закомментирован по той же
 * причине.
 */
async function acceptTos(auth: AuthState, tosToken: string): Promise<void> {
  const res = await playPostForm(`${URL_FDFE}/acceptTos`, defaultHeaders(auth), {
    tost: tosToken,
    toscme: 'false',
  });
  if (res.statusCode !== 200) throw new Error(`acceptTos: HTTP ${res.statusCode}`);
}

export interface BuildAuthOptions {
  email?: string;
  aasToken?: string;
  deviceName?: string;
  locale?: string;
  /** Игнорировать кэш и пройти checkin заново (регистрирует НОВОЕ устройство). */
  fresh?: boolean;
  /** Принять Play ToS, если Google их требует. Меняет состояние аккаунта. */
  acceptTos?: boolean;
}

/**
 * Готовое состояние клиента: gsfId + токены. Состояние кэшируется на диск —
 * повторный checkin на каждый запуск плодит устройства в аккаунте Google и
 * ускоряет бан.
 */
export async function buildAuth(opts: BuildAuthOptions = {}): Promise<AuthState> {
  const email = opts.email ?? process.env.FINSKY_EMAIL ?? '';
  const aasToken = opts.aasToken ?? process.env.FINSKY_AAS_TOKEN ?? '';
  const deviceName = opts.deviceName ?? process.env.FINSKY_DEVICE ?? DEFAULT_DEVICE;
  const locale = opts.locale ?? process.env.FINSKY_LOCALE ?? 'en_US';
  if (!email || !aasToken) {
    throw new Error('нужны FINSKY_EMAIL и FINSKY_AAS_TOKEN');
  }

  const device = loadDevice(deviceName);
  const cached = opts.fresh ? null : readState();
  const reusable =
    cached && cached.email === email && cached.deviceName === deviceName && cached.gsfId;

  const auth: AuthState = {
    email,
    gsfId: reusable ? cached.gsfId : '',
    authToken: '',
    deviceConfigToken: reusable ? cached.deviceConfigToken : '',
    consistencyToken: reusable ? cached.consistencyToken : '',
    dfeCookie: '',
    device,
    locale,
  };

  if (!auth.gsfId) {
    const checkedIn = await checkin(device, locale);
    auth.gsfId = checkedIn.gsfId;
    auth.consistencyToken = checkedIn.consistencyToken;
  }

  const tokenFresh =
    reusable && cached.authToken && Date.now() - cached.authTokenAt < TOKEN_TTL_MS;
  auth.authToken = tokenFresh
    ? cached.authToken
    : await generatePlayToken(email, aasToken, device, locale, auth.gsfId);

  // Не критично: X-DFE-Device-Config-Token лишь уточняет совместимость выдачи,
  // поиск работает и без него. Падать всей авторизацией из-за этого шага нельзя.
  if (!auth.deviceConfigToken) {
    try {
      auth.deviceConfigToken = await uploadDeviceConfig(auth);
    } catch (e) {
      console.warn(`[finsky] uploadDeviceConfig пропущен: ${(e as Error).message}`);
    }
  }

  const wantsTos = opts.acceptTos ?? process.env.FINSKY_ACCEPT_TOS === '1';
  if (wantsTos) {
    const { tosToken, cookie } = await toc(auth);
    auth.dfeCookie = cookie;
    if (tosToken) {
      await acceptTos(auth, tosToken);
      console.warn('[finsky] Play ToS приняты для этого устройства');
    }
  }

  writeState({
    email,
    deviceName,
    locale,
    gsfId: auth.gsfId,
    consistencyToken: auth.consistencyToken,
    deviceConfigToken: auth.deviceConfigToken,
    authToken: auth.authToken,
    authTokenAt: tokenFresh ? cached.authTokenAt : Date.now(),
  });

  return auth;
}

/** Проверка живости состояния: /fdfe/toc отвечает 200 только с валидным токеном. */
export async function isAuthValid(auth: AuthState): Promise<boolean> {
  try {
    const res = await playGet(`${URL_FDFE}/toc`, defaultHeaders(auth));
    return res.statusCode === 200;
  } catch {
    return false;
  }
}

export { URL_FDFE };
