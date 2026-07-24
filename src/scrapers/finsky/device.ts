import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Профиль «виртуального устройства» для Finsky.
 *
 * Файлы devices/*.properties — дампы реальных телефонов из AuroraOSS/gplayapi
 * (GPL-3.0-or-later). Их формат — java.util.Properties, поэтому двоеточие в
 * Build.FINGERPRINT экранировано (`tegu\:15`) и требует распаковки.
 *
 * Один профиль = одно устройство в аккаунте Google. Менять профиль на лету
 * нельзя: checkin с новым профилем регистрирует НОВОЕ устройство на аккаунт,
 * их число не бесконечно. Профиль фиксируется вместе с gsfId (см. auth.ts).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DEVICES_DIR = join(HERE, 'devices');

export const DEFAULT_DEVICE = 'px_9a';

/** Разбор java.util.Properties: комментарии, `=`/`:` как разделитель, escape-последовательности. */
function parseProperties(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;

    // Разделитель — первый НЕэкранированный '=' или ':'.
    let sep = -1;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '\\') { i++; continue; }
      if (line[i] === '=' || line[i] === ':') { sep = i; break; }
    }
    if (sep === -1) continue;

    const key = line.slice(0, sep).trim();
    const value = line
      .slice(sep + 1)
      .trim()
      .replace(/\\(.)/g, (_m, ch: string) => {
        if (ch === 'n') return '\n';
        if (ch === 't') return '\t';
        if (ch === 'r') return '\r';
        return ch; // \: \= \\ и прочее — просто снимаем слэш
      });
    out.set(key, value);
  }
  return out;
}

export class DeviceProfile {
  readonly name: string;
  private readonly props: Map<string, string>;

  constructor(name: string, props: Map<string, string>) {
    this.name = name;
    this.props = props;
    for (const field of ['Build.FINGERPRINT', 'GSF.version', 'Vending.version', 'Platforms']) {
      if (!props.has(field)) throw new Error(`${name}.properties: нет поля ${field}`);
    }
  }

  get(key: string, fallback = ''): string {
    return this.props.get(key) ?? fallback;
  }

  int(key: string, fallback = 0): number {
    const n = Number(this.props.get(key));
    return Number.isFinite(n) ? n : fallback;
  }

  list(key: string): string[] {
    const raw = this.props.get(key);
    return raw ? raw.split(',').filter(Boolean) : [];
  }

  get sdkVersion(): number { return this.int('Build.VERSION.SDK_INT'); }
  get playServicesVersion(): number { return this.int('GSF.version'); }
  get mccMnc(): string { return this.get('SimOperator'); }

  /** User-Agent для android.clients.google.com/auth. */
  get authUserAgent(): string {
    return `GoogleAuth/1.4 (${this.get('Build.DEVICE')} ${this.get('Build.ID')})`;
  }

  /** User-Agent Play Store для /fdfe/*. */
  get userAgent(): string {
    const params = [
      'api=3',
      `versionCode=${this.get('Vending.version')}`,
      `sdk=${this.get('Build.VERSION.SDK_INT')}`,
      `device=${this.get('Build.DEVICE')}`,
      `hardware=${this.get('Build.HARDWARE')}`,
      `product=${this.get('Build.PRODUCT')}`,
      `platformVersionRelease=${this.get('Build.VERSION.RELEASE')}`,
      `model=${this.get('Build.MODEL')}`,
      `buildId=${this.get('Build.ID')}`,
      'isWideScreen=0',
      `supportedAbis=${this.list('Platforms').join(';')}`,
    ];
    return `Android-Finsky/${this.get('Vending.versionString')} (${params.join(',')})`;
  }

  /** DeviceConfigurationProto — тело uploadDeviceConfig и часть checkin. */
  deviceConfiguration(): Record<string, unknown> {
    return {
      touchScreen: this.int('TouchScreen'),
      keyboard: this.int('Keyboard'),
      navigation: this.int('Navigation'),
      screenLayout: this.int('ScreenLayout'),
      hasHardKeyboard: this.get('HasHardKeyboard') === 'true',
      hasFiveWayNavigation: this.get('HasFiveWayNavigation') === 'true',
      lowRamDevice: this.int('LowRamDevice', 0),
      maxNumOfCPUCores: this.int('MaxNumOfCPUCores', 8),
      // 64-битные поля protobufjs принимает числом или Long, но не строкой.
      totalMemoryBytes: this.int('TotalMemoryBytes', 8_589_935_000),
      deviceClass: 0,
      screenDensity: this.int('Screen.Density'),
      screenWidth: this.int('Screen.Width'),
      screenHeight: this.int('Screen.Height'),
      nativePlatform: this.list('Platforms'),
      systemSharedLibrary: this.list('SharedLibraries'),
      systemAvailableFeature: this.list('Features'),
      systemSupportedLocale: this.list('Locales'),
      glEsVersion: this.int('GL.Version'),
      glExtension: this.list('GL.Extensions'),
      deviceFeature: this.list('Features').map((name) => ({ name, value: 0 })),
    };
  }

  /** AndroidCheckinRequest — регистрация устройства, ответ даёт androidId (gsfId). */
  checkinRequest(locale: string, timeZone = this.get('TimeZone', 'UTC')): Record<string, unknown> {
    return {
      id: 0,
      checkin: {
        build: {
          id: this.get('Build.FINGERPRINT'),
          product: this.get('Build.HARDWARE'),
          carrier: this.get('Build.BRAND'),
          radio: this.get('Build.RADIO'),
          bootloader: this.get('Build.BOOTLOADER'),
          device: this.get('Build.DEVICE'),
          sdkVersion: this.sdkVersion,
          model: this.get('Build.MODEL'),
          manufacturer: this.get('Build.MANUFACTURER'),
          buildProduct: this.get('Build.PRODUCT'),
          client: this.get('Client'),
          otaInstalled: this.get('OtaInstalled', 'false') === 'true',
          timestamp: Math.floor(Date.now() / 1000),
          googleServices: this.playServicesVersion,
        },
        lastCheckinMsec: 0,
        cellOperator: this.get('CellOperator'),
        simOperator: this.get('SimOperator'),
        roaming: this.get('Roaming'),
        userNumber: 0,
      },
      locale,
      timeZone,
      version: 3,
      deviceConfiguration: this.deviceConfiguration(),
      fragment: 0,
    };
  }
}

const cache = new Map<string, DeviceProfile>();

/** Профиль устройства по имени файла (без расширения), с кэшем на процесс. */
export function loadDevice(name = DEFAULT_DEVICE): DeviceProfile {
  const cached = cache.get(name);
  if (cached) return cached;
  const text = readFileSync(join(DEVICES_DIR, `${name}.properties`), 'utf8');
  const profile = new DeviceProfile(name, parseProperties(text));
  cache.set(name, profile);
  return profile;
}
