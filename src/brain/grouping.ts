import { Task } from '../types';
import { AFFIRMATIONS, keywordTokens, overlap } from '../util';
import { AiEngine } from './ai-engine';

export interface GroupingResult {
  decision: 'new' | 'append';
  /** Khi append: id của task được khớp. */
  taskId?: string;
  reason: 'heuristic' | 'llm';
  confidence?: number;
}

/** Ngưỡng overlap từ khoá để coi là cùng task (fallback khi không có AI). */
const HEURISTIC_MATCH_THRESHOLD = 0.4;
const MAX_CANDIDATES = 30;

const SHORT_TEXT_LEN = 30;

const BOUNDARY_PHRASES = [
  'việc khác', 'task mới', 'chuyển sang', 'qua phần', 'qua việc', 'sang việc',
  'new task', 'different task', 'chuyển qua', 'bây giờ làm', 'giờ làm', 'làm tiếp việc',
];

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function isAffirmation(text: string): boolean {
  const n = normalize(text).replace(/[.!?\s]+$/g, '');
  if (n.length > 20) {
    return false;
  }
  return AFFIRMATIONS.includes(n);
}

function hasBoundary(text: string): boolean {
  const n = normalize(text);
  return BOUNDARY_PHRASES.some((p) => n.includes(p));
}

function candidateText(t: Task): string {
  const recent = t.turns.slice(-2).map((x) => x.text).join(' ');
  return `${t.title} ${t.summary} ${recent}`;
}

/**
 * Quyết định một lượt mới THUỘC về task nào (so khớp ngữ nghĩa với MỌI task đang mở),
 * hay là việc mới — theo spec "tìm task gần nhất; đủ giống thì update, không thì tạo mới".
 *
 * - `candidates`: các task đang mở trong dự án, sắp xếp mới-nhất-trước.
 * - AI (matchTask) là cơ chế ngữ nghĩa chính; heuristic overlap là fallback.
 * - Câu nối lẻ ("Go", "tiếp đi") gắn vào task mới-nhất; cụm "việc khác" ép tạo mới.
 */
export async function decideGrouping(
  text: string,
  _ts: string,
  sessionId: string,
  candidates: Task[],
  _idleGapMinutes: number,
  ai: AiEngine,
  allowHeuristic = true,
): Promise<GroupingResult> {
  if (candidates.length === 0) {
    return { decision: 'new', reason: 'heuristic' };
  }
  // ranh giới rõ ràng → việc mới
  if (hasBoundary(text)) {
    return { decision: 'new', reason: 'heuristic', confidence: 0.8 };
  }
  // câu nối lẻ ngắn → gắn vào task đang mở mới nhất (không bao giờ là việc mới có nghĩa)
  if (isAffirmation(text) || normalize(text).length < SHORT_TEXT_LEN) {
    return { decision: 'append', taskId: candidates[0].id, reason: 'heuristic', confidence: 0.85 };
  }

  const pool = candidates.slice(0, MAX_CANDIDATES);

  // 1) AI matcher (ngữ nghĩa)
  const match = await ai.matchTask(
    text,
    pool.map((t) => ({ id: t.id, title: t.title, summary: t.summary })),
  );
  if (match) {
    if (match.taskId && pool.some((t) => t.id === match.taskId)) {
      return { decision: 'append', taskId: match.taskId, reason: 'llm', confidence: match.confidence };
    }
    return { decision: 'new', reason: 'llm', confidence: match.confidence };
  }

  // Ở chế độ AI mà matchTask lỗi → tạo task MỚI (KHÔNG đoán bằng heuristic kém chính xác).
  if (!allowHeuristic) {
    return { decision: 'new', reason: 'llm', confidence: 0 };
  }

  // 2) heuristic fallback (chỉ khi không có AI): overlap từ khoá với từng task
  const promptTokens = keywordTokens(text);
  let best: { id: string; score: number } | undefined;
  for (const t of pool) {
    const score = overlap(promptTokens, keywordTokens(candidateText(t)));
    if (!best || score > best.score) {
      best = { id: t.id, score };
    }
  }
  if (best && best.score >= HEURISTIC_MATCH_THRESHOLD) {
    return { decision: 'append', taskId: best.id, reason: 'heuristic', confidence: best.score };
  }
  // Prior khi overlap yếu & KHÔNG có AI: nối vào task mới nhất nếu cùng phiên (liên tục).
  if (pool[0].sessionIds.includes(sessionId)) {
    return { decision: 'append', taskId: pool[0].id, reason: 'heuristic', confidence: 0.45 };
  }
  return { decision: 'new', reason: 'heuristic', confidence: 0.4 };
}
