// Resize media/Mind.png -> media/icon.png (256x256) bằng Node thuần (zlib built-in).
// Decode PNG (colortype 2/6, 8-bit) -> unfilter -> area-average downscale -> encode RGBA.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SRC = path.join(__dirname, '..', 'media', 'Mind.png');
const DEST = path.join(__dirname, '..', 'media', 'icon.png');
const OUT = 256;

// ---------- decode ----------
function decodePNG(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error('Không phải PNG');
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
  const bitDepth = b[24], colorType = b[25];
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`Chỉ hỗ trợ 8-bit RGB/RGBA (bitDepth=${bitDepth}, colorType=${colorType})`);
  }
  const channels = colorType === 6 ? 4 : 3;
  // gom IDAT
  const idat = [];
  let off = 8;
  while (off < b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idat.push(b.slice(off + 8, off + 8 + len));
    if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  // unfilter
  const bpp = channels;
  const stride = w * bpp;
  const out = Buffer.alloc(stride * h);
  const paeth = (a, bb, c) => {
    const p = a + bb - c, pa = Math.abs(p - a), pb = Math.abs(p - bb), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? bb : c;
  };
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const rowIn = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const v = raw[rowIn + x];
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const up = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      let r;
      switch (ft) {
        case 0: r = v; break;
        case 1: r = v + a; break;
        case 2: r = v + up; break;
        case 3: r = v + ((a + up) >> 1); break;
        case 4: r = v + paeth(a, up, c); break;
        default: throw new Error('filter lạ ' + ft);
      }
      out[y * stride + x] = r & 0xff;
    }
  }
  return { w, h, channels, data: out };
}

// Dò bán kính bo góc: quét hàng gần mép trên, tìm x đầu tiên không-đen (= R).
function detectRadius(src) {
  const { w, h, channels, data } = src;
  const isBlack = (x, y) => {
    const i = (y * w + x) * channels;
    return data[i] + data[i + 1] + data[i + 2] < 60;
  };
  const rs = [];
  for (const y of [1, 3, 5]) {
    let x = 0;
    while (x < w / 2 && isBlack(x, y)) x++;
    rs.push(x);
  }
  rs.sort((a, b) => a - b);
  return rs[1]; // trung vị
}

// ---------- area-average downscale + mặt nạ rounded-rect (góc đen -> trong suốt) ----------
function resizeRGBA(src, OUTW, radius) {
  const { w, h, channels, data } = src;
  const rgba = Buffer.alloc(OUTW * OUTW * 4);
  // mặt nạ rounded-rect phủ toàn ảnh, bán kính `radius` (toạ độ nguồn)
  const inMask = (x, y) => {
    const qx = Math.abs(x + 0.5 - w / 2) - (w / 2 - radius);
    const qy = Math.abs(y + 0.5 - h / 2) - (h / 2 - radius);
    const sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
    return sd <= 0;
  };
  for (let oy = 0; oy < OUTW; oy++) {
    const sy0 = Math.floor((oy * h) / OUTW), sy1 = Math.max(sy0 + 1, Math.floor(((oy + 1) * h) / OUTW));
    for (let ox = 0; ox < OUTW; ox++) {
      const sx0 = Math.floor((ox * w) / OUTW), sx1 = Math.max(sx0 + 1, Math.floor(((ox + 1) * w) / OUTW));
      let r = 0, g = 0, bl = 0, cn = 0; // màu: chỉ pixel trong mặt nạ & không gần-đen
      let inside = 0, total = 0;          // alpha: tỉ lệ pixel trong mặt nạ
      for (let sy = sy0; sy < sy1; sy++)
        for (let sx = sx0; sx < sx1; sx++) {
          total++;
          if (!inMask(sx, sy)) continue;
          inside++;
          const si = (sy * w + sx) * channels;
          const R = data[si], G = data[si + 1], B = data[si + 2];
          if (R + G + B >= 60) { r += R; g += G; bl += B; cn++; } // bỏ pixel gần-đen khỏi màu
        }
      const di = (oy * OUTW + ox) * 4;
      if (cn > 0) { rgba[di] = Math.round(r / cn); rgba[di + 1] = Math.round(g / cn); rgba[di + 2] = Math.round(bl / cn); }
      rgba[di + 3] = Math.round((inside / total) * 255);
    }
  }
  return rgba;
}

// ---------- encode RGBA PNG ----------
function crc32(b) {
  let c = ~0;
  for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(rgba, w, h) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const stride = w * 4, raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride); }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const src = decodePNG(SRC);
const radius = detectRadius(src);
console.log(`[resize-icon] nguồn: ${src.w}x${src.h}, ${src.channels} kênh, bán kính bo góc ≈ ${radius}px`);
const rgba = resizeRGBA(src, OUT, radius);
fs.writeFileSync(DEST, encodePNG(rgba, OUT, OUT));
console.log(`[resize-icon] OK → ${DEST} (${OUT}x${OUT}, góc trong suốt)`);
