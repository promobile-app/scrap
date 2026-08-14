import { URL_FDFE } from './auth.js';
import { defaultHeaders, type AuthState } from './headers.js';
import { playGet } from './http.js';
import { decodeProto } from './proto.js';

/**
 * Детали приложения через Finsky.
 *
 * Нужно ради размера: Google убрал его из веб-листинга Play, и
 * `scrapers/googleplay.ts` (как и любой веб-парсер) физически не может его
 * отдать — в разметке страницы размера нет вообще. Мобильный клиент получает
 * его в AppDetails.infoDownloadSize.
 *
 * `variesWithDevice` отличает «нет размера» от «размер зависит от устройства»:
 * при app bundle Play собирает APK под конкретное устройство, единого числа
 * не существует, и там же Play рисует «Varies with device» вместо версии.
 * Размер в этом случае приходит для профиля устройства из FINSKY_DEVICE.
 */

const URL_DETAILS = `${URL_FDFE}/details`;

export interface FinskyAppDetails {
  packageName: string;
  title: string;
  developer: string;
  /** Размер загрузки в байтах, 0 если Play его не отдал. */
  size: number;
  /** true — размер зависит от устройства, число выше для профиля FINSKY_DEVICE. */
  variesWithDevice: boolean;
  /** Версия как строка («3.3.214»), пустая если приложение без фиксированной версии. */
  version: string;
  /** Дата обновления как её рисует Play («Jul 21, 2026»), локализована. */
  updatedOn: string;
  installs: number;
  rating: number;
  ratings: number;
}

interface ProtoAppDetails {
  packageName?: string;
  title?: string;
  developerName?: string;
  versionString?: string;
  infoUpdatedOn?: string;
  infoDownloadSize?: string;
  variesWithDevice?: boolean;
  downloadCount?: string;
  file?: { size?: string }[];
}

interface ProtoWrapper {
  payload?: {
    detailsResponse?: {
      item?: {
        id?: string;
        title?: string;
        creator?: string;
        details?: { appDetails?: ProtoAppDetails };
        aggregateRating?: { starRating?: number; ratingsCount?: string };
      };
    };
  };
}

/**
 * Размер берём из infoDownloadSize, а если его нет — из file[].size: у
 * приложений с несколькими сплитами Play отдаёт размер пофайлово, суммируем.
 */
function sizeOf(details?: ProtoAppDetails): number {
  const info = Number(details?.infoDownloadSize ?? 0);
  if (Number.isFinite(info) && info > 0) return info;

  const files = (details?.file ?? []).reduce((sum, f) => {
    const size = Number(f?.size ?? 0);
    return sum + (Number.isFinite(size) && size > 0 ? size : 0);
  }, 0);
  return files;
}

export async function finskyDetails(
  auth: AuthState,
  packageName: string,
): Promise<FinskyAppDetails | null> {
  const res = await playGet(URL_DETAILS, defaultHeaders(auth), {
    doc: packageName,
  });

  if (res.statusCode === 404) return null;
  if (res.statusCode !== 200) {
    throw new Error(
      `finsky details ${packageName}: HTTP ${res.statusCode} ${res.body
        .toString('utf8')
        .slice(0, 200)}`,
    );
  }

  const wrapper = await decodeProto<ProtoWrapper>('ResponseWrapper', res.body);
  const item = wrapper.payload?.detailsResponse?.item;
  const details = item?.details?.appDetails;
  if (!item || !details) return null;

  return {
    packageName: details.packageName ?? item.id ?? packageName,
    title: details.title ?? item.title ?? '',
    developer: details.developerName ?? item.creator ?? '',
    size: sizeOf(details),
    variesWithDevice: details.variesWithDevice ?? false,
    version: details.versionString ?? '',
    updatedOn: details.infoUpdatedOn ?? '',
    installs: Number(details.downloadCount ?? 0) || 0,
    rating: item.aggregateRating?.starRating ?? 0,
    ratings: Number(item.aggregateRating?.ratingsCount ?? 0) || 0,
  };
}
