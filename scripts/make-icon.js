// Sinh icon PNG cho extension Task Mind — thuần Node (chỉ dùng zlib built-in).
// Render ở 1024px rồi thu nhỏ xuống 256px (box filter 4x4) để cạnh mượt (khử răng cưa).
// Concept: nền gradient indigo→violet bo góc + BỘ NÃO trắng (có rãnh nếp gấp) + huy hiệu ✓ (task).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SS = 1024; // độ phân giải render
const OUT = 256; // độ phân giải xuất
const SCALE = SS / OUT;
const BG_R = 200; // bo góc nền

const buf = Buffer.alloc(SS * SS * 4, 0);
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const lerp = (a, b, t) => a + (b - a) * t;

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
const inBG = (x, y) => sdRoundRect(x, y, SS / 2, SS / 2, SS / 2, SS / 2, BG_R) <= 0;

function bgColor(x, y) {
  const t = (x + y) / (2 * SS);
  return [lerp(99, 168, t), lerp(102, 85, t), lerp(241, 247, t)];
}
function over(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= SS || y >= SS || a <= 0 || !inBG(x, y)) return;
  const i = (y * SS + x) * 4;
  const ia = 1 - a;
  buf[i] = Math.round(r * a + buf[i] * ia);
  buf[i + 1] = Math.round(g * a + buf[i + 1] * ia);
  buf[i + 2] = Math.round(b * a + buf[i + 2] * ia);
  buf[i + 3] = Math.round(a * 255 + buf[i + 3] * ia);
}
function setBG(x, y) {
  const [r, g, b] = bgColor(x, y);
  over(x, y, r, g, b, 1);
}

function distSeg(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay, wx = px - ax, wy = py - ay;
  let t = (wx * vx + wy * vy) / (vx * vx + vy * vy);
  t = clamp(t, 0, 1);
  return Math.hypot(ax + t * vx - px, ay + t * vy - py);
}
function distPath(px, py, pts) {
  let d = Infinity;
  for (let i = 0; i < pts.length - 1; i++)
    d = Math.min(d, distSeg(px, py, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]));
  return d;
}
// làm mượt polyline điều khiển thành đường cong (Catmull-Rom)
function smooth(pts, seg = 18) {
  const res = [];
  const P = [pts[0], ...pts, pts[pts.length - 1]];
  for (let i = 1; i < P.length - 2; i++) {
    const [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]];
    for (let s = 0; s < seg; s++) {
      const t = s / seg, t2 = t * t, t3 = t2 * t;
      const x = 0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const y = 0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      res.push([x, y]);
    }
  }
  res.push(pts[pts.length - 1]);
  return res;
}
function starVerts(cx, cy, R, r, points = 4, rot = -Math.PI / 2) {
  const v = [];
  for (let i = 0; i < points * 2; i++) {
    const rad = i % 2 === 0 ? R : r;
    const ang = rot + (i * Math.PI) / points;
    v.push([cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad]);
  }
  return v;
}
function inPoly(px, py, v) {
  let inside = false;
  for (let i = 0, j = v.length - 1; i < v.length; j = i++) {
    const [xi, yi] = v[i], [xj, yj] = v[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// --- 1) nền gradient bo góc ---
for (let y = 0; y < SS; y++)
  for (let x = 0; x < SS; x++) if (inBG(x, y)) setBG(x, y);

// helpers shape
function bbox(cx, cy, rad, fn) {
  for (let y = Math.floor(cy - rad - 2); y <= cy + rad + 2; y++)
    for (let x = Math.floor(cx - rad - 2); x <= cx + rad + 2; x++) fn(x, y);
}
function fillCircle(cx, cy, rad, col, a) {
  bbox(cx, cy, rad, (x, y) => { if (Math.hypot(x - cx, y - cy) <= rad) over(x, y, col[0], col[1], col[2], a); });
}
function fillCircleBG(cx, cy, rad) {
  bbox(cx, cy, rad, (x, y) => { if (Math.hypot(x - cx, y - cy) <= rad) setBG(x, y); });
}
function strokePath(pts, hw, col, a) {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  for (let y = Math.floor(Math.min(...ys) - hw - 2); y <= Math.max(...ys) + hw + 2; y++)
    for (let x = Math.floor(Math.min(...xs) - hw - 2); x <= Math.max(...xs) + hw + 2; x++)
      if (distPath(x, y, pts) <= hw) over(x, y, col[0], col[1], col[2], a);
}
function strokePathBG(pts, hw) {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  for (let y = Math.floor(Math.min(...ys) - hw - 2); y <= Math.max(...ys) + hw + 2; y++)
    for (let x = Math.floor(Math.min(...xs) - hw - 2); x <= Math.max(...xs) + hw + 2; x++)
      if (distPath(x, y, pts) <= hw) setBG(x, y);
}
function fillStar(cx, cy, R, r, col, a) {
  const v = starVerts(cx, cy, R, r);
  bbox(cx, cy, R, (x, y) => { if (inPoly(x, y, v)) over(x, y, col[0], col[1], col[2], a); });
}

const WHITE = [255, 255, 255];
const VIOLET = [91, 33, 182];

// --- 2) BỘ NÃO (union các đường tròn → khối trắng bồng bềnh) ---
const brain = [
  [360, 360, 118], [468, 330, 134], [578, 366, 116],   // bướu trên
  [300, 452, 122], [470, 442, 150], [642, 458, 116],   // trên-giữa
  [330, 560, 128], [482, 560, 140], [624, 560, 116],   // giữa
  [398, 652, 120], [540, 650, 120],                    // dưới
];
for (const [cx, cy, r] of brain) fillCircle(cx, cy, r, WHITE, 1);

// --- 3) rãnh nếp gấp (carve màu nền lên khối trắng) ---
strokePathBG(smooth([[460, 286], [476, 360], [450, 432], [472, 504], [450, 576], [464, 650]]), 16); // chia bán cầu
strokePathBG(smooth([[360, 392], [314, 452], [344, 516], [314, 578]]), 15);                          // C trái
strokePathBG(smooth([[598, 392], [646, 452], [612, 516], [644, 578]]), 15);                          // C phải
strokePathBG(smooth([[392, 596], [438, 632], [412, 686]]), 13);                                      // nếp dưới-trái
strokePathBG(smooth([[372, 470], [330, 500], [356, 548]]), 12);                                      // nếp trái nhỏ
strokePathBG(smooth([[612, 468], [654, 500], [628, 548]]), 12);                                      // nếp phải nhỏ

// --- 4) huy hiệu ✓ (task) góc dưới phải ---
const bx = 748, by = 752;
fillCircleBG(bx, by, 188);          // moat tách khỏi não
fillCircle(bx, by, 158, WHITE, 1);  // đĩa trắng
strokePath([[bx - 62, by + 4], [bx - 20, by + 48], [bx + 66, by - 46]], 26, VIOLET, 1); // dấu ✓

// --- 5) sparkle nhỏ (AI) ---
fillStar(852, 214, 58, 21, WHITE, 1);

// --- downsample 1024 -> 256 ---
const out = Buffer.alloc(OUT * OUT * 4);
for (let oy = 0; oy < OUT; oy++)
  for (let ox = 0; ox < OUT; ox++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let j = 0; j < SCALE; j++)
      for (let i = 0; i < SCALE; i++) {
        const si = ((oy * SCALE + j) * SS + (ox * SCALE + i)) * 4;
        r += buf[si]; g += buf[si + 1]; b += buf[si + 2]; a += buf[si + 3];
      }
    const n = SCALE * SCALE, di = (oy * OUT + ox) * 4;
    out[di] = Math.round(r / n); out[di + 1] = Math.round(g / n);
    out[di + 2] = Math.round(b / n); out[di + 3] = Math.round(a / n);
  }

// --- encode PNG ---
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

const dest = path.join(__dirname, '..', 'media', 'icon.png');
fs.writeFileSync(dest, encodePNG(out, OUT, OUT));
console.log(`[make-icon] OK → ${dest} (${OUT}x${OUT})`);
