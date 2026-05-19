// Генератор иконок расширения RankRadar (16/48/128 px) без внешних зависимостей.
// Рисует логотип-радар: концентрические круги на фиолетовом градиенте.
// Запуск: node extension/gen-icons.mjs
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePNG(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    rgba.copy(raw, y * (1 + size * 4) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

function insideRounded(u, v, cr) {
  const dx = Math.max(Math.abs(u - 0.5) - (0.5 - cr), 0);
  const dy = Math.max(Math.abs(v - 0.5) - (0.5 - cr), 0);
  return Math.hypot(dx, dy) <= cr;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = clamp01(t);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function renderIcon(size) {
  const SS = 4;
  const W = size * SS;
  const hi = Buffer.alloc(W * W * 4);
  const cr = 0.23;
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W;
      const v = (y + 0.5) / W;
      let R = 0, G = 0, B = 0, A = 0;
      if (insideRounded(u, v, cr)) {
        const t = clamp01((u + v) / 2);
        R = lerp(0x4a, 0x2f, t);
        G = lerp(0x7b, 0x5f, t);
        B = lerp(0xff, 0xe0, t);
        A = 255;
        const dist = Math.hypot(u - 0.5, v - 0.5);
        const white = (amt) => {
          R = lerp(R, 255, amt);
          G = lerp(G, 255, amt);
          B = lerp(B, 255, amt);
        };
        const ringW = 0.028;
        if (Math.abs(dist - 0.39) < ringW) white(0.6);
        if (Math.abs(dist - 0.25) < ringW) white(0.9);
        if (dist < 0.1) white(1);
        const ex = 0.5 + 0.34 * 0.707;
        const ey = 0.5 - 0.34 * 0.707;
        if (distToSegment(u, v, 0.5, 0.5, ex, ey) < 0.03) white(1);
      }
      const i = (y * W + x) * 4;
      hi[i] = Math.round(R);
      hi[i + 1] = Math.round(G);
      hi[i + 2] = Math.round(B);
      hi[i + 3] = Math.round(A);
    }
  }
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * W + (x * SS + sx)) * 4;
          const pa = hi[i + 3];
          r += hi[i] * pa;
          g += hi[i + 1] * pa;
          b += hi[i + 2] * pa;
          a += pa;
        }
      }
      const o = (y * size + x) * 4;
      out[o] = a ? Math.round(r / a) : 0;
      out[o + 1] = a ? Math.round(g / a) : 0;
      out[o + 2] = a ? Math.round(b / a) : 0;
      out[o + 3] = Math.round(a / (SS * SS));
    }
  }
  return out;
}

for (const s of [16, 48, 128]) {
  writeFileSync(new URL(`./icon${s}.png`, import.meta.url), encodePNG(s, renderIcon(s)));
  console.log(`icon${s}.png`);
}
