import { jaccard, keywordTokens } from '../util';
import { AiEngine } from './ai-engine';

export interface EpicDecision {
  epicId: string;
  epicTitle?: string;
  reason: 'heuristic' | 'llm';
  confidence: number;
}

const HEURISTIC_MATCH_THRESHOLD = 0.2;

/**
 * Gán task vào một Epic. Ưu tiên AI; nếu không có thì heuristic (jaccard từ khoá).
 * Trả undefined nghĩa là chưa phân loại được (để task ở nhóm "Khác").
 */
export async function classifyTask(params: {
  taskText: string;
  existingEpics: Array<{ id: string; title: string }>;
  ai: AiEngine;
  autoClassify: boolean;
  newEpicId: () => string;
}): Promise<EpicDecision | undefined> {
  const { taskText, existingEpics, ai, autoClassify, newEpicId } = params;
  if (!autoClassify) {
    return undefined;
  }

  // 1) thử AI
  const aiRes = await ai.classifyEpic(taskText, existingEpics);
  if (aiRes) {
    if (aiRes.epicId && existingEpics.some((e) => e.id === aiRes.epicId)) {
      return { epicId: aiRes.epicId, reason: 'llm', confidence: aiRes.confidence };
    }
    return { epicId: newEpicId(), epicTitle: aiRes.epicTitle, reason: 'llm', confidence: aiRes.confidence };
  }

  // 2) heuristic: jaccard từ khoá với tiêu đề epic
  const taskTokens = keywordTokens(taskText);
  let best: { id: string; score: number } | undefined;
  for (const e of existingEpics) {
    const score = jaccard(taskTokens, keywordTokens(e.title));
    if (!best || score > best.score) {
      best = { id: e.id, score };
    }
  }
  if (best && best.score >= HEURISTIC_MATCH_THRESHOLD) {
    return { epicId: best.id, reason: 'heuristic', confidence: best.score };
  }

  // 3) không khớp & không có AI → để task ở nhóm "Khác" (không tạo epic rác).
  //    Epic chất lượng được tạo bởi AI; heuristic chỉ gom khi đủ giống.
  return undefined;
}

/** Chuyển snapshot TodoWrite của agent thành danh sách subtask. */
export function subtasksFromTodos(todos: Array<{ content: string; status: string }>): Array<{ title: string; done: boolean }> {
  return todos
    .filter((t) => t.content && t.content.trim())
    .map((t) => ({ title: t.content.trim(), done: t.status === 'completed' }));
}

/** Chẻ subtask bằng AI (nếu khả dụng). */
export async function decomposeSubtasks(taskText: string, ai: AiEngine): Promise<string[]> {
  const res = await ai.decompose(taskText);
  return res ?? [];
}
