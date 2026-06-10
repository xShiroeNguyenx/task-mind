// Tiện ích thuần (không phụ thuộc vscode) — dùng chung và test được headless.

/** Khoá phân vùng theo dự án, chuẩn hoá đường dẫn cwd (Windows: thường hoá + đổi \ thành /). */
export function projectKeyFromCwd(cwd: string): string {
  return cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Tên dự án ngắn gọn (segment cuối của cwd). */
export function projectNameFromCwd(cwd: string): string {
  const norm = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = norm.split('/');
  return parts[parts.length - 1] || norm;
}

const MD_STRIP = /[`*_#>~-]+/g;

/** Tiêu đề heuristic: dòng đầu có nội dung, bỏ markdown, cắt ~80 ký tự. */
export function heuristicTitle(text: string): string {
  const firstLine = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? '';
  let t = firstLine.replace(MD_STRIP, ' ').replace(/\s+/g, ' ').trim();
  if (t.length > 80) {
    t = t.slice(0, 79).trimEnd() + '…';
  }
  return t || 'Việc không tên';
}

/** Tóm tắt heuristic: nối các đoạn text, cắt ~280 ký tự. */
export function heuristicSummary(texts: string[]): string {
  const joined = texts
    .map((t) => t.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' • ');
  if (joined.length > 280) {
    return joined.slice(0, 279).trimEnd() + '…';
  }
  return joined;
}

/** yyyy-mm-dd theo giờ địa phương từ một ISO timestamp. */
export function localDateKey(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** yyyy-mm-dd của "hôm nay" theo giờ địa phương. */
export function todayKey(now: Date = new Date()): string {
  return localDateKey(now.toISOString());
}

/** Mô tả thời gian tương đối bằng tiếng Việt. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  const diffMs = now.getTime() - then;
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) {
    return 'vừa xong';
  }
  const min = Math.round(sec / 60);
  if (min < 60) {
    return `${min} phút trước`;
  }
  const hr = Math.round(min / 60);
  if (hr < 24) {
    return `${hr} giờ trước`;
  }
  const day = Math.round(hr / 24);
  if (day < 30) {
    return `${day} ngày trước`;
  }
  return localDateKey(iso);
}

/** Nhãn nhóm theo ngày: Hôm nay / Hôm qua / yyyy-mm-dd. */
export function dayGroupLabel(dateKey: string, now: Date = new Date()): string {
  const today = todayKey(now);
  const yesterday = localDateKey(new Date(now.getTime() - 24 * 3600 * 1000).toISOString());
  if (dateKey === today) {
    return 'Hôm nay';
  }
  if (dateKey === yesterday) {
    return 'Hôm qua';
  }
  return dateKey;
}

/** Cắt gọn văn bản kèm dấu lược. */
export function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

/** Lời chào / câu xã giao thuần, không mang nội dung công việc. */
const GREETINGS = [
  'hi', 'hì', 'hí', 'hị', 'hello', 'helo', 'hallo', 'hế lô', 'hê lô', 'hế nhô',
  'hey', 'hey bạn', 'yo', 'alo', 'allo', 'a lô', 'chào', 'chào bạn', 'chào ad',
  'xin chào', 'dạ', 'hí hí', 'hì hì',
];

/** Câu cảm ơn thuần. */
const THANKS = [
  'cảm ơn', 'cám ơn', 'cảm ơn bạn', 'cám ơn bạn', 'cảm ơn nhé', 'cám ơn nhé',
  'thanks', 'thank you', 'thank', 'tks', 'thank u', 'ty',
];

/** Câu xác nhận / nối ngắn — không mang nội dung việc mới. */
export const AFFIRMATIONS = [
  'ok', 'oke', 'okay', 'yes', 'y', 'ừ', 'ừm', 'uh', 'đúng', 'đúng rồi', 'chuẩn',
  'tiếp', 'tiếp đi', 'tiếp tục', 'làm đi', 'continue', 'go', 'go ahead', 'đồng ý',
  'ngon', 'được', 'oki', 'tốt', 'next', 'proceed',
];

/**
 * Lượt rõ ràng KHÔNG phải việc: lời chào, cảm ơn, câu xác nhận lẻ, hoặc không có chữ/số
 * (toàn emoji/dấu câu). Dùng để KHÔNG tạo task MỚI từ các lượt này. Cố tình bảo thủ:
 * câu có nội dung (kể cả câu hỏi) hoặc dài sẽ KHÔNG bị coi là non-task.
 */
export function isNonTaskTurn(text: string): boolean {
  const n = text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?,~…\s]+$/g, '')
    .trim();
  if (!n) {
    return true;
  }
  // không có chữ/số (toàn emoji, dấu câu) → không thể là việc
  if (!/[a-z0-9à-ỹ]/i.test(n)) {
    return true;
  }
  // đủ dài → có thể mang nội dung việc, không lọc
  if (n.length > 25) {
    return false;
  }
  return GREETINGS.includes(n) || THANKS.includes(n) || AFFIRMATIONS.includes(n);
}

/**
 * Quyết định có TỰ XOÁ một task mà AI không đặt được tên hay không. Logic an toàn-trên-hết:
 * chỉ xoá khi (1) được phép ở ngữ cảnh này, (2) người dùng bật setting, (3) engine LÀ AI thật
 * (không rơi heuristic), và (4) KHÔNG có lỗi gọi AI (mạng/429/sai key). Tức chỉ xoá khi AI đã
 * trả lời bình thường nhưng nội dung quá mỏng để đặt tên.
 */
export function shouldAutoDeleteFailed(p: {
  allow: boolean;
  setting: boolean;
  aiReady: boolean;
  hasError: boolean;
}): boolean {
  return p.allow && p.setting && p.aiReady && !p.hasError;
}

/** So sánh từ khoá đơn giản để gom Epic heuristic. */
export function keywordTokens(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9à-ỹ\s/._-]/gi, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3);
  return new Set(tokens);
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let inter = 0;
  for (const x of a) {
    if (b.has(x)) {
      inter++;
    }
  }
  return inter / (a.size + b.size - inter);
}

/** Hệ số overlap: phần giao / kích thước tập nhỏ hơn (tốt cho prompt ngắn vs task dài). */
export function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let inter = 0;
  for (const x of a) {
    if (b.has(x)) {
      inter++;
    }
  }
  return inter / Math.min(a.size, b.size);
}
