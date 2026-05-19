/**
 * Разбор ссылок на приложение в App Store / Google Play.
 * Из ссылки извлекаем платформу, ID приложения и гео (страну витрины).
 */

export interface ParsedStoreUrl {
  platform: 'ios' | 'android';
  appId: string;
  country: string;
}

export function parseStoreUrl(input: string): ParsedStoreUrl {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('Некорректная ссылка');
  }
  const host = url.hostname.toLowerCase();

  // App Store: apps.apple.com/<country>/app/<name>/id<digits>
  if (host.endsWith('apple.com')) {
    const country = (url.pathname.match(/\/([a-z]{2})\/app\//i)?.[1] ?? 'us').toLowerCase();
    const idMatch = url.pathname.match(/id(\d+)/);
    if (!idMatch) throw new Error('В ссылке App Store не найден ID приложения');
    return { platform: 'ios', appId: idMatch[1], country };
  }

  // Google Play: play.google.com/store/apps/details?id=<package>&gl=<country>
  if (host.endsWith('play.google.com')) {
    const appId = url.searchParams.get('id');
    if (!appId) throw new Error('В ссылке Google Play не найден параметр id');
    const country = (url.searchParams.get('gl') ?? 'us').toLowerCase();
    return { platform: 'android', appId, country };
  }

  throw new Error('Поддерживаются только ссылки App Store и Google Play');
}
