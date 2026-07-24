import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';

/**
 * Схема protobuf внутреннего API Google Play (Finsky).
 *
 * proto/GooglePlay.proto взят из AuroraOSS/gplayapi (GPL-3.0-or-later,
 * https://gitlab.com/AuroraOSS/gplayapi) — это единственная схема, которая
 * поддерживается в живом состоянии; MCMrARM/Google-Play-API заброшен с 2020.
 * Мы используем её как сетевой сервис (не распространяем бинарь), поэтому
 * копилефт GPL нас не обязывает раскрывать сервис — сетевой оговорки, как в
 * AGPL, здесь нет. При переносе кода в клиентское приложение условия меняются.
 *
 * Схема грузится лениво и один раз на процесс: парсинг ~2300 строк не бесплатный.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = join(HERE, 'proto', 'GooglePlay.proto');

let rootPromise: Promise<protobuf.Root> | null = null;

function loadRoot(): Promise<protobuf.Root> {
  if (!rootPromise) rootPromise = protobuf.load(PROTO_PATH);
  return rootPromise;
}

/** Тип из схемы по имени (`ResponseWrapper`, `AndroidCheckinRequest`, ...). */
export async function protoType(name: string): Promise<protobuf.Type> {
  const root = await loadRoot();
  return root.lookupType(name);
}

/** Сериализация plain-объекта в bytes по типу схемы. */
export async function encodeProto(
  typeName: string,
  payload: Record<string, unknown>,
): Promise<Buffer> {
  const type = await protoType(typeName);
  const err = type.verify(payload);
  if (err) throw new Error(`${typeName}: ${err}`);
  return Buffer.from(type.encode(type.create(payload)).finish());
}

/**
 * Разбор bytes в plain-объект.
 *
 * `longs: String` — иначе fixed64 (androidId, ratingsCount) приходит объектом
 * long.js и молча ломает арифметику и шаблонные строки.
 */
export async function decodeProto<T = Record<string, unknown>>(
  typeName: string,
  bytes: Buffer | Uint8Array,
): Promise<T> {
  const type = await protoType(typeName);
  const message = type.decode(bytes);
  return type.toObject(message, {
    longs: String,
    enums: String,
    bytes: String,
    defaults: false,
    arrays: true,
    objects: true,
  }) as T;
}
