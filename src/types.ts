// Kiểu dữ liệu lõi cho Task Mind.
//
// Kiến trúc: một EVENT LOG append-only là nguồn sự thật; Epic/Task/Subtask/DailyReport
// là các "projection" tính lại được bằng cách phát lại (replay) toàn bộ event log.

export type Iso = string; // ISO-8601 timestamp, vd "2026-06-05T06:06:24.884Z"

export type WorkItemKind = 'epic' | 'task' | 'subtask';

export type TaskStatus = 'in_progress' | 'done' | 'abandoned';

/** Một lượt người dùng thật (đã lọc rác) gắn vào task. */
export interface TaskTurn {
  ts: Iso;
  sessionId: string;
  promptId: string;
  lineUuid: string;
  text: string;
  assistantExcerpt?: string;
}

// ---------------------------------------------------------------------------
// CAPTURE EVENTS — mỗi phần tử là một dòng trong event log.
// ---------------------------------------------------------------------------

export interface BaseEvent {
  eventId: string;
  ts: Iso;
}

/** Một lượt người dùng thật bắt được từ transcript. */
export interface HumanTurnEvent extends BaseEvent {
  type: 'human_turn';
  sessionId: string;
  promptId: string;
  lineUuid: string;
  cwd: string;
  projectKey: string;
  text: string;
  gitBranch?: string;
  version?: string;
  entrypoint?: string;
}

/** Trích đoạn phản hồi của assistant (để tóm tắt / báo cáo). */
export interface AssistantTextEvent extends BaseEvent {
  type: 'assistant_text';
  sessionId: string;
  promptId: string;
  lineUuid: string;
  cwd: string;
  textExcerpt: string;
  model?: string;
}

/** Metadata của phiên (vd ai-title của Claude Code). */
export interface SessionMetaEvent extends BaseEvent {
  type: 'session_meta';
  sessionId: string;
  cwd: string;
  aiTitle?: string;
}

/** Snapshot todo của agent (TodoWrite) — nguồn để chẻ Subtask. */
export interface AgentTodoEvent extends BaseEvent {
  type: 'agent_todo';
  sessionId: string;
  cwd: string;
  todos: Array<{ content: string; status: string }>;
}

/** Quyết định gom nhóm: lượt T thuộc task nào (mới / nối tiếp). */
export interface GroupingDecisionEvent extends BaseEvent {
  type: 'grouping_decision';
  turnRef: string; // lineUuid của lượt
  taskId: string;
  decision: 'new' | 'append';
  reason: 'heuristic' | 'llm' | 'manual';
  confidence?: number;
}

/** Quyết định phân loại: task thuộc Epic nào. */
export interface ClassificationEvent extends BaseEvent {
  type: 'classification';
  taskId: string;
  epicId: string;
  epicTitle?: string;
  reason: 'heuristic' | 'llm' | 'manual';
  confidence?: number;
}

/** Một subtask (từ TodoWrite của agent, AI chẻ, hoặc người dùng thêm). */
export interface SubtaskEvent extends BaseEvent {
  type: 'subtask';
  taskId: string;
  subtaskId: string;
  title: string;
  source: 'ai' | 'agent-todo' | 'manual';
  done?: boolean;
}

/** Tiêu đề + tóm tắt cho Task hoặc Epic. */
export interface SummaryEvent extends BaseEvent {
  type: 'summary';
  targetId: string;
  targetKind: 'epic' | 'task';
  title: string;
  summary: string;
  lang: string;
  source: 'ai-title' | 'lm' | 'external' | 'heuristic';
  /** AI lỗi → đánh dấu task cần dựng lại (không chế tên heuristic). */
  failed?: boolean;
}

export type CorrectionOp =
  | 'merge'
  | 'split'
  | 'set_status'
  | 'retitle'
  | 'set_epic'
  | 'create_epic'
  | 'rename_epic'
  | 'delete_epic'
  | 'move_task'
  | 'promote'
  | 'demote'
  | 'toggle_subtask'
  | 'delete_subtask'
  | 'delete_task';

/** Chỉnh sửa của người dùng — luôn append, không ghi đè. */
export interface CorrectionEvent extends BaseEvent {
  type: 'correction';
  op: CorrectionOp;
  payload: Record<string, any>;
}

export type CaptureEvent =
  | HumanTurnEvent
  | AssistantTextEvent
  | SessionMetaEvent
  | AgentTodoEvent
  | GroupingDecisionEvent
  | ClassificationEvent
  | SubtaskEvent
  | SummaryEvent
  | CorrectionEvent;

// ---------------------------------------------------------------------------
// PROJECTIONS — kết quả tính lại từ event log.
// ---------------------------------------------------------------------------

export interface Subtask {
  id: string;
  kind: 'subtask';
  taskId: string;
  title: string;
  status: 'todo' | 'done';
  source: 'ai' | 'agent-todo' | 'manual';
  createdAt: Iso;
}

export interface Task {
  id: string;
  kind: 'task';
  epicId?: string;
  subtaskIds: string[];
  projectKey: string;
  cwd: string;
  title: string;
  summary: string;
  summarySource: SummaryEvent['source'] | 'none';
  lang: string;
  status: TaskStatus;
  createdAt: Iso;
  updatedAt: Iso;
  sessionIds: string[];
  turns: TaskTurn[];
  tags: string[];
  groupingConfidence?: number;
  classifyConfidence?: number;
  /** Cần tóm tắt lại (có lượt mới kể từ lần tóm tắt cuối). */
  needsResummarize: boolean;
  /** AI đặt tên/tóm tắt thất bại — cần người dùng dựng lại task này. */
  summaryFailed: boolean;
}

export interface Epic {
  id: string;
  kind: 'epic';
  projectKey: string;
  cwd: string;
  title: string;
  summary: string;
  source: 'ai' | 'manual';
  createdAt: Iso;
  updatedAt: Iso;
  taskIds: string[];
}

/** Trạng thái hiển thị suy ra lúc đọc (stale = có vẻ xong nhưng chưa tick). */
export type DisplayStatus = TaskStatus | 'stale';

export interface DailyReport {
  date: string; // yyyy-mm-dd (giờ địa phương)
  generatedAt: Iso;
  // Gom theo DỰ ÁN để khớp cây checklist (trước đây gom theo Epic).
  perProject: Array<{
    projectKey: string;
    projectName: string;
    cwd: string;
    tasksCompleted: string[];
    tasksInProgress: string[];
    tasksStarted: string[];
  }>;
  totals: {
    started: number;
    completed: number;
    inProgress: number;
    turns: number;
    sessions: number;
  };
  narrative: string;
}
