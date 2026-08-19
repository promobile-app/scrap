// Скриншот витрины: страница приложения в App Store, снятая headless-браузером
// в мобильном вьюпорте.
//
// Зачем через браузер, а не сборкой из данных: карточку у Apple видно только
// как её рисует сам Apple — обрезка названия, порядок блоков, «Покупки в
// програмі», строка возраста и графика. Пересобранный макет всегда отличается
// от оригинала, а вопрос у пользователя ровно про оригинал: как ЭТО выглядит в
// чужой стране.
//
// Мобильный User-Agent сюда не годится: на него apps.apple.com отвечает
// редиректом в itms-apps:// (открыть нативный App Store), и навигация падает с
// ERR_ABORTED. Поэтому UA десктопный, а телефонность даёт вьюпорт 390×844 —
// адаптивная вёрстка Apple на такой ширине отдаёт ровно мобильную раскладку.
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { config } from '../config.js';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Кэш лежит в public/, поэтому раздаётся уже подключённым fastify-static. */
const SHOTS_DIR = join(projectRoot, 'public', 'storefronts');
const SHOTS_URL = '/storefronts';

/** Витрина меняется редко: сутки — компромисс между свежестью и ценой рендера. */
const TTL_MS = Number(process.env.STOREFRONT_SHOT_TTL_MS ?? 24 * 60 * 60 * 1000);
/** Сколько страниц рендерим одновременно: каждый контекст — это память. */
const CONCURRENCY = Number(process.env.STOREFRONT_SHOT_CONCURRENCY ?? 3);
/** Браузер закрывается после простоя, чтобы не держать ~200 МБ впустую. */
const IDLE_CLOSE_MS = Number(process.env.STOREFRONT_SHOT_IDLE_MS ?? 5 * 60 * 1000);

export interface StorefrontShot {
  country: string;
  language: string | null;
  /** Адрес страницы, с которой снят кадр. */
  url: string;
  /** Путь к картинке на этом сервере: /storefronts/<hash>.jpg */
  image: string;
  width: number;
  height: number;
  /** Заголовок страницы витрины — по нему видно, на каком языке отдалась выдача. */
  title: string | null;
  /** true — отдан кэш, рендера не было. */
  cached: boolean;
}

let browser: Browser | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let inFlight = 0;
const queue: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (inFlight < CONCURRENCY) {
    inFlight++;
    return;
  }
  await new Promise<void>((resolve) => queue.push(resolve));
  inFlight++;
}

function releaseSlot(): void {
  inFlight--;
  queue.shift()?.();
}

async function getBrowser(): Promise<Browser> {
  if (idleTimer) clearTimeout(idleTimer);
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      // Песочница недоступна в контейнере без привилегий — стандартный набор
      // флагов для headless в докере.
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  }
  return browser;
}

function scheduleIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (inFlight > 0) return scheduleIdleClose();
    const current = browser;
    browser = null;
    await current?.close().catch(() => undefined);
  }, IDLE_CLOSE_MS);
}

const appPageUrl = (appId: string | number, country: string, language?: string) =>
  `https://apps.apple.com/${country.toLowerCase()}/app/id${appId}` +
  (language ? `?l=${language.toLowerCase()}` : '');

const cacheKey = (parts: unknown[]) =>
  createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);

export interface StorefrontShotOptions {
  appId: string | number;
  country: string;
  /** Язык витрины (`?l=`); без него — язык витрины по умолчанию. */
  language?: string;
  width?: number;
  height?: number;
  /** Снять страницу целиком, а не первый экран. */
  fullPage?: boolean;
  /** Игнорировать кэш и снять заново. */
  refresh?: boolean;
}

/**
 * Снимает одну витрину. Возвращает null, если страница не открылась: витрина
 * без приложения — нормальный ответ (приложение просто не издано в этой
 * стране), а не ошибка всего запроса.
 */
export async function storefrontShot(
  opts: StorefrontShotOptions,
): Promise<StorefrontShot | null> {
  const {
    appId,
    country,
    language,
    width = 390,
    height = 844,
    fullPage = false,
    refresh = false,
  } = opts;

  const url = appPageUrl(appId, country, language);
  const key = cacheKey([appId, country, language ?? '', width, height, fullPage]);
  const file = join(SHOTS_DIR, `${key}.jpg`);
  const image = `${SHOTS_URL}/${key}.jpg`;
  const metaFile = join(SHOTS_DIR, `${key}.json`);

  if (!refresh) {
    const cached = await stat(file).catch(() => null);
    if (cached && Date.now() - cached.mtimeMs < TTL_MS) {
      const meta = await readFile(metaFile, 'utf8')
        .then((raw) => JSON.parse(raw) as { title: string | null })
        .catch(() => ({ title: null }));
      return {
        country, language: language ?? null, url, image, width, height,
        title: meta.title, cached: true,
      };
    }
  }

  await acquireSlot();
  try {
    const instance = await getBrowser();
    const context = await instance.newContext({
      viewport: { width, height },
      deviceScaleFactor: 2,
      // Локаль влияет на Accept-Language, а он — на язык витрины, когда `?l=`
      // не задан.
      locale: language ? `${language}-${country.toUpperCase()}` : undefined,
    });

    try {
      const page = await context.newPage();
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      if (!response || response.status() >= 400) return null;

      // Скриншоты витрины подгружаются лениво; ждём галерею, но не жёстко —
      // у приложения без скриншотов её не будет, а карточка всё равно нужна.
      await page
        .locator('picture source, .we-screenshot-viewer, img')
        .first()
        .waitFor({ state: 'visible', timeout: 5_000 })
        .catch(() => undefined);
      await page.waitForTimeout(800);

      const title = await page.title().catch(() => null);
      const buffer = await page.screenshot({ type: 'jpeg', quality: 82, fullPage });

      await mkdir(SHOTS_DIR, { recursive: true });
      await writeFile(file, buffer);
      await writeFile(metaFile, JSON.stringify({ title, url, takenAt: new Date().toISOString() }));

      return {
        country, language: language ?? null, url, image, width, height,
        title, cached: false,
      };
    } finally {
      await context.close().catch(() => undefined);
    }
  } catch (err) {
    if (!config.isProduction) {
      console.warn(`[storefront] ${country}/${appId} не снялась: ${String(err)}`);
    }
    return null;
  } finally {
    releaseSlot();
    scheduleIdleClose();
  }
}

/** Снимает пачку витрин одного приложения; порядок ответа — как в запросе. */
export async function storefrontShots(
  appId: string | number,
  countries: string[],
  opts: Omit<StorefrontShotOptions, 'appId' | 'country'> = {},
): Promise<Array<StorefrontShot | null>> {
  return Promise.all(
    countries.map((country) => storefrontShot({ ...opts, appId, country })),
  );
}
