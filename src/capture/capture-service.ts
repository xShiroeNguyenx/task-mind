import * as vscode from 'vscode';
import { CaptureEvent, CorrectionOp } from '../types';
import { EventLog } from '../store/event-log';
import { Projection } from '../store/projection';
import { projectKeyFromCwd } from '../util';

/**
 * Seam tích hợp: UI (tree, lệnh, báo cáo) chỉ phụ thuộc interface này.
 * Cắm Mock trước, sau thay bằng dịch vụ đọc transcript thật mà không đổi UI.
 */
export interface CaptureService {
  readonly onDidChange: vscode.Event<void>;
  start(): Promise<void>;
  dispose(): void;
  getProjection(): Projection;
  newId(): string;
  /** Ghi một correction của người dùng (append-only) rồi tính lại. */
  applyCorrection(op: CorrectionOp, payload: Record<string, any>): Promise<void>;
  /** Ghi trực tiếp một loạt event (vd subtask thủ công) rồi tính lại. */
  append(events: CaptureEvent[]): Promise<void>;
  refresh(): Promise<void>;
  /** Dựng lại toàn bộ task từ các lượt đã bắt (gom nhóm lại). Trả engine + số tên AI/fail. */
  reprocess(
    useAi: boolean,
    onProgress?: (msg: string) => void,
    opts?: { keepAllHistory?: boolean },
  ): Promise<{
    tasks: number;
    engine: string;
    aiTitles?: number;
    heuristic?: number;
    failed?: number;
    autoDeleted?: number;
    restored?: number;
    restoredSubtasks?: number;
    droppedByCutoff?: number;
    error?: string;
  }>;
  /** Ước lượng số việc sẽ bị cắt theo cửa sổ backfillDays khi reprocess (cho cảnh báo trước). */
  reprocessImpact(): { droppedTasks: number; backfillDays: number };
  /** Dựng lại tên/tóm tắt cho MỘT task bằng AI (task bị cờ fail). */
  retryTask(taskId: string): Promise<{ ok: boolean; engine: string; error?: string }>;
  /** Xoá mọi task AI không đặt được tên (cờ ⚠️). Trả số đã xoá. */
  deleteFailedTasks(): Promise<number>;
  /** Kiểm tra AI có khả dụng không (gọi thử 1 lần). */
  aiStatus(): Promise<{ engine: string; ok: boolean; sample?: string; error?: string }>;
  /** Lệnh dev: tạo một việc mẫu. */
  simulateTask(): Promise<void>;
}

function nowIso(): string {
  return new Date().toISOString();
}

const SAMPLE_TASKS: Array<{ text: string; epic: string; subtasks: string[] }> = [
  {
    text: 'Thêm đăng nhập bằng Google cho trang web',
    epic: 'Authentication',
    subtasks: ['Tạo OAuth client', 'Thêm nút Google Login', 'Lưu phiên đăng nhập'],
  },
  {
    text: 'Thêm đăng nhập bằng Facebook',
    epic: 'Authentication',
    subtasks: ['Đăng ký app Facebook', 'Tích hợp SDK'],
  },
  {
    text: 'Làm chức năng quên mật khẩu / reset password',
    epic: 'Authentication',
    subtasks: ['Gửi email reset', 'Trang đặt lại mật khẩu'],
  },
  {
    text: 'Tối ưu truy vấn danh sách sản phẩm bị chậm',
    epic: 'Performance',
    subtasks: ['Thêm index DB', 'Cache kết quả'],
  },
];

export abstract class BaseCaptureService implements CaptureService {
  protected readonly log: EventLog;
  protected projection = new Projection();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private sampleIndex = 0;

  constructor(storageDir: string) {
    this.log = new EventLog(storageDir);
  }

  async start(): Promise<void> {
    await this.log.load();
    this.rebuild();
    await this.onStart();
  }

  protected abstract onStart(): Promise<void>;

  dispose(): void {
    this._onDidChange.dispose();
  }

  getProjection(): Projection {
    return this.projection;
  }

  newId(): string {
    return this.log.newEventId();
  }

  protected rebuild(): void {
    this.projection = Projection.build(this.log.getAll());
  }

  protected fire(): void {
    this._onDidChange.fire();
  }

  /** Ghi 1 event + áp tăng dần vào projection hiện tại (O(1)), KHÔNG rebuild/fire.
   *  Dùng cho luồng ingest khối lượng lớn; gọi finalizeAndFire() ở cuối batch. */
  protected async logAndApply(ev: CaptureEvent): Promise<void> {
    await this.log.append(ev);
    this.projection.apply(ev);
  }

  protected finalizeAndFire(): void {
    this.projection.finalize();
    this.fire();
  }

  protected async appendEvents(events: CaptureEvent[]): Promise<void> {
    await this.log.appendMany(events);
    this.rebuild();
    this.fire();
  }

  async append(events: CaptureEvent[]): Promise<void> {
    await this.appendEvents(events);
  }

  async applyCorrection(op: CorrectionOp, payload: Record<string, any>): Promise<void> {
    await this.appendEvents([
      { type: 'correction', op, payload, eventId: this.newId(), ts: nowIso() },
    ]);
  }

  async refresh(): Promise<void> {
    await this.log.flush();
    this.rebuild();
    this.fire();
  }

  /** Mặc định: chỉ rebuild (Mock không gom nhóm lại). TaskMindService override. */
  async reprocess(
    _useAi: boolean,
    _onProgress?: (msg: string) => void,
    _opts?: { keepAllHistory?: boolean },
  ): Promise<{ tasks: number; engine: string; aiTitles?: number; heuristic?: number; failed?: number; error?: string }> {
    this.rebuild();
    this.fire();
    return { tasks: this.projection.getTasks().length, engine: 'n/a' };
  }

  /** Mặc định: base/Mock không cắt theo ngày. TaskMindService override. */
  reprocessImpact(): { droppedTasks: number; backfillDays: number } {
    return { droppedTasks: 0, backfillDays: 0 };
  }

  async retryTask(_taskId: string): Promise<{ ok: boolean; engine: string; error?: string }> {
    return { ok: false, engine: 'n/a' };
  }

  async deleteFailedTasks(): Promise<number> {
    return 0;
  }

  async aiStatus(): Promise<{ engine: string; ok: boolean; sample?: string; error?: string }> {
    return { engine: 'heuristic', ok: false };
  }

  async simulateTask(): Promise<void> {
    const sample = SAMPLE_TASKS[this.sampleIndex % SAMPLE_TASKS.length];
    this.sampleIndex++;
    const cwd =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
      'd:\\NGUYENKHANH\\GLOBAL_WORKSPACE\\task-mind';
    const projectKey = projectKeyFromCwd(cwd);
    const sessionId = this.newId();
    const promptId = this.newId();
    const lineUuid = this.newId();
    const taskId = this.newId();
    const epicId = `epic-${sample.epic.toLowerCase()}-${projectKey}`;
    const ts = nowIso();
    const events: CaptureEvent[] = [
      { type: 'human_turn', eventId: this.newId(), ts, sessionId, promptId, lineUuid, cwd, projectKey, text: sample.text },
      { type: 'grouping_decision', eventId: this.newId(), ts, turnRef: lineUuid, taskId, decision: 'new', reason: 'heuristic' },
      { type: 'classification', eventId: this.newId(), ts, taskId, epicId, epicTitle: sample.epic, reason: 'heuristic', confidence: 0.5 },
    ];
    for (const sub of sample.subtasks) {
      events.push({ type: 'subtask', eventId: this.newId(), ts, taskId, subtaskId: this.newId(), title: sub, source: 'ai' });
    }
    events.push({
      type: 'summary',
      eventId: this.newId(),
      ts,
      targetId: taskId,
      targetKind: 'task',
      title: sample.text,
      summary: sample.text,
      lang: 'vi',
      source: 'heuristic',
    });
    await this.appendEvents(events);
  }
}
