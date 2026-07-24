import type { DeviceProfile } from './device.js';
import { X_DFE_ENCODED_TARGETS, X_DFE_PHENOTYPE } from './targets.js';

/**
 * Заголовки клиента Play. Порт data/providers/HeaderProvider.kt из
 * AuroraOSS/gplayapi (GPL-3.0-or-later).
 */

export interface AuthState {
  email: string;
  gsfId: string;
  authToken: string;
  deviceConfigToken: string;
  consistencyToken: string;
  dfeCookie: string;
  device: DeviceProfile;
  /** java-style локаль: `ru_RU`, `en_US`. */
  locale: string;
}

/** Заголовки для android.clients.google.com/auth и /checkin. */
export function authHeaders(device: DeviceProfile, gsfId = ''): Record<string, string> {
  const headers: Record<string, string> = {
    app: 'com.google.android.gms',
    'User-Agent': device.authUserAgent,
  };
  if (gsfId) headers.device = gsfId;
  return headers;
}

/** Заголовки для /fdfe/* — без них сервер отдаёт 403 либо пустой payload. */
export function defaultHeaders(auth: AuthState): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.authToken}`,
    'User-Agent': auth.device.userAgent,
    'X-DFE-Device-Id': auth.gsfId,
    'Accept-Language': auth.locale.replace('_', '-'),
    'X-DFE-Encoded-Targets': X_DFE_ENCODED_TARGETS,
    'X-DFE-Phenotype': X_DFE_PHENOTYPE,
    'X-DFE-Client-Id': 'am-android-google',
    'X-DFE-Network-Type': '4',
    'X-DFE-Content-Filters': '',
    'X-Limit-Ad-Tracking-Enabled': 'false',
    'X-Ad-Id': '',
    'X-DFE-UserLanguages': auth.locale,
    'X-DFE-Request-Params': 'timeoutMs=4000',
  };
  if (auth.consistencyToken) {
    headers['X-DFE-Device-Checkin-Consistency-Token'] = auth.consistencyToken;
  }
  if (auth.deviceConfigToken) headers['X-DFE-Device-Config-Token'] = auth.deviceConfigToken;
  if (auth.dfeCookie) headers['X-DFE-Cookie'] = auth.dfeCookie;
  const mccMnc = auth.device.mccMnc;
  if (mccMnc) headers['X-DFE-MCCMNC'] = mccMnc;
  return headers;
}
