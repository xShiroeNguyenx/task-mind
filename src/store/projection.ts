import {
  CaptureEvent,
  Epic,
  Subtask,
  Task,
  TaskTurn,
} from '../types';
import { heuristicTitle } from '../util';

interface SessionMeta {
  cwd: string;
  aiTitle?: string;
}

/**
 * Trạng thái suy ra từ event log. `apply()` là reducer thuần: phát lại cùng một
 * chuỗi event luôn cho cùng kết quả → idempotent, đồng bộ nhiều cửa sổ, sửa được sau.
 */
export class Projection {
  readonly epics = new Map<string, Epic>();
  readonly tasks = new Map<string, Task>();
  readonly subtasks = new Map<string, Subtask>();
  readonly sessionMeta = new Map<string, SessionMeta>();
  readonly latestTodos = new Map<string, Array<{ content: string; status: string }>>();

  private readonly rawTurns = new Map<string, { ev: any }>(); // lineUuid -> human_turn ev
  private readonly assistantText = new Map<string, string>(); // sessionId:promptId -> excerpt
  private readonly processedTurns = new Set<string>(); // lineUuid
  private readonly deletedTasks = new Set<string>();
  private readonly deletedEpics = new Set<string>();
  private readonly deletedSubtasks = new Set<string>();

  static build(events: CaptureEvent[]): Projection {
    const p = new Projection();
    for (const ev of events) {
      p.apply(ev);
    }
    p.finalize();
    return p;
  }

  hasProcessedTurn(lineUuid: string): boolean {
    return this.processedTurns.has(lineUuid);
  }

  apply(ev: CaptureEvent): void {
    switch (ev.type) {
      case 'human_turn':
        this.rawTurns.set(ev.lineUuid, { ev });
        this.processedTurns.add(ev.lineUuid);
        if (!this.sessionMeta.has(ev.sessionId)) {
          this.sessionMeta.set(ev.sessionId, { cwd: ev.cwd });
        }
        break;

      case 'assistant_text': {
        const key = `${ev.sessionId}:${ev.promptId}`;
        this.assistantText.set(key, ev.textExcerpt);
        // gắn vào turn cùng promptId nếu task đã có
        for (const task of this.tasks.values()) {
          for (const t of task.turns) {
            if (t.sessionId === ev.sessionId && t.promptId === ev.promptId && !t.assistantExcerpt) {
              t.assistantExcerpt = ev.textExcerpt;
            }
          }
        }
        break;
      }

      case 'session_meta':
        this.sessionMeta.set(ev.sessionId, { cwd: ev.cwd, aiTitle: ev.aiTitle });
        break;

      case 'agent_todo':
        this.latestTodos.set(ev.sessionId, ev.todos);
        break;

      case 'grouping_decision':
        this.applyGrouping(ev);
        break;

      case 'classification':
        this.applyClassification(ev);
        break;

      case 'subtask':
        this.applySubtask(ev);
        break;

      case 'summary':
        this.applySummary(ev);
        break;

      case 'correction':
        this.applyCorrection(ev);
        break;
    }
  }

  private applyGrouping(ev: Extract<CaptureEvent, { type: 'grouping_decision' }>): void {
    const raw = this.rawTurns.get(ev.turnRef);
    if (!raw) {
      return;
    }
    // Idempotency: một lượt chỉ thuộc đúng MỘT task. Nếu lượt này đã nằm trong task khác
    // (do event gom nhóm bị lặp — vd dữ liệu bị nạp trùng), bỏ qua để không tạo task trùng.
    // Trên dữ liệu sạch đây là no-op (mỗi lượt chỉ có 1 grouping_decision).
    for (const t of this.tasks.values()) {
      if (t.id !== ev.taskId && t.turns.some((x) => x.lineUuid === ev.turnRef)) {
        return;
      }
    }
    const r = raw.ev;
    const turn: TaskTurn = {
      ts: r.ts,
      sessionId: r.sessionId,
      promptId: r.promptId,
      lineUuid: r.lineUuid,
      text: r.text,
      assistantExcerpt: this.assistantText.get(`${r.sessionId}:${r.promptId}`),
    };
    let task = this.tasks.get(ev.taskId);
    if (ev.decision === 'new' || !task) {
      task = {
        id: ev.taskId,
        kind: 'task',
        subtaskIds: [],
        projectKey: r.projectKey,
        cwd: r.cwd,
        title: heuristicTitle(r.text),
        summary: '',
        summarySource: 'none',
        lang: 'vi',
        status: 'in_progress',
        createdAt: r.ts,
        updatedAt: r.ts,
        sessionIds: [r.sessionId],
        turns: [turn],
        tags: [],
        groupingConfidence: ev.confidence,
        needsResummarize: true,
        summaryFailed: false,
      };
      this.tasks.set(task.id, task);
    } else {
      if (!task.turns.some((t) => t.lineUuid === turn.lineUuid)) {
        task.turns.push(turn);
      }
      if (!task.sessionIds.includes(r.sessionId)) {
        task.sessionIds.push(r.sessionId);
      }
      if (r.ts > task.updatedAt) {
        task.updatedAt = r.ts;
      }
      if (r.ts < task.createdAt) {
        task.createdAt = r.ts;
      }
      task.needsResummarize = true;
      task.groupingConfidence = ev.confidence;
    }
  }

  private ensureEpic(id: string, title: string | undefined, cwd: string, projectKey: string, source: 'ai' | 'manual', ts: string): Epic {
    let epic = this.epics.get(id);
    if (!epic) {
      epic = {
        id,
        kind: 'epic',
        projectKey,
        cwd,
        title: title || 'Khác',
        summary: '',
        source,
        createdAt: ts,
        updatedAt: ts,
        taskIds: [],
      };
      this.epics.set(id, epic);
    } else if (title) {
      epic.title = title;
    }
    return epic;
  }

  private applyClassification(ev: Extract<CaptureEvent, { type: 'classification' }>): void {
    const task = this.tasks.get(ev.taskId);
    if (!task) {
      return;
    }
    // gỡ khỏi epic cũ
    if (task.epicId && this.epics.has(task.epicId)) {
      const old = this.epics.get(task.epicId)!;
      old.taskIds = old.taskIds.filter((id) => id !== task.id);
    }
    const epic = this.ensureEpic(
      ev.epicId,
      ev.epicTitle,
      task.cwd,
      task.projectKey,
      ev.reason === 'manual' ? 'manual' : 'ai',
      ev.ts,
    );
    task.epicId = epic.id;
    task.classifyConfidence = ev.confidence;
    if (!epic.taskIds.includes(task.id)) {
      epic.taskIds.push(task.id);
    }
    if (ev.ts > epic.updatedAt) {
      epic.updatedAt = ev.ts;
    }
  }

  private applySubtask(ev: Extract<CaptureEvent, { type: 'subtask' }>): void {
    const task = this.tasks.get(ev.taskId);
    if (!task) {
      return;
    }
    let st = this.subtasks.get(ev.subtaskId);
    if (!st) {
      st = {
        id: ev.subtaskId,
        kind: 'subtask',
        taskId: ev.taskId,
        title: ev.title,
        status: ev.done ? 'done' : 'todo',
        source: ev.source,
        createdAt: ev.ts,
      };
      this.subtasks.set(st.id, st);
    } else {
      st.title = ev.title;
      if (ev.done !== undefined) {
        st.status = ev.done ? 'done' : 'todo';
      }
    }
    if (!task.subtaskIds.includes(st.id)) {
      task.subtaskIds.push(st.id);
    }
  }

  private applySummary(ev: Extract<CaptureEvent, { type: 'summary' }>): void {
    if (ev.targetKind === 'task') {
      const task = this.tasks.get(ev.targetId);
      if (!task) {
        return;
      }
      task.title = ev.title;
      task.summary = ev.summary;
      task.summarySource = ev.source;
      task.lang = ev.lang;
      // AI lỗi: giữ cờ fail + vẫn cần dựng lại; thành công: xoá cờ.
      task.summaryFailed = ev.failed === true;
      task.needsResummarize = ev.failed === true;
    } else {
      const epic = this.epics.get(ev.targetId);
      if (!epic) {
        return;
      }
      epic.title = ev.title;
      epic.summary = ev.summary;
    }
  }

  private applyCorrection(ev: Extract<CaptureEvent, { type: 'correction' }>): void {
    const p = ev.payload || {};
    switch (ev.op) {
      case 'set_status': {
        const task = this.tasks.get(p.taskId);
        if (task && (p.status === 'in_progress' || p.status === 'done' || p.status === 'abandoned')) {
          task.status = p.status;
          task.updatedAt = ev.ts > task.updatedAt ? ev.ts : task.updatedAt;
        }
        break;
      }
      case 'retitle': {
        if (p.targetKind === 'epic') {
          const epic = this.epics.get(p.id);
          if (epic) {
            epic.title = p.title;
          }
        } else {
          const task = this.tasks.get(p.id);
          if (task) {
            task.title = p.title;
            task.summarySource = task.summarySource === 'none' ? 'heuristic' : task.summarySource;
          }
        }
        break;
      }
      case 'set_epic':
      case 'move_task': {
        const task = this.tasks.get(p.taskId);
        if (!task) {
          break;
        }
        if (task.epicId && this.epics.has(task.epicId)) {
          const old = this.epics.get(task.epicId)!;
          old.taskIds = old.taskIds.filter((id) => id !== task.id);
        }
        const epic = this.ensureEpic(p.epicId, p.epicTitle, task.cwd, task.projectKey, 'manual', ev.ts);
        task.epicId = epic.id;
        if (!epic.taskIds.includes(task.id)) {
          epic.taskIds.push(task.id);
        }
        break;
      }
      case 'create_epic': {
        this.ensureEpic(p.epicId, p.title, p.cwd ?? '', p.projectKey ?? '', 'manual', ev.ts);
        break;
      }
      case 'rename_epic': {
        const epic = this.epics.get(p.epicId);
        if (epic) {
          epic.title = p.title;
        }
        break;
      }
      case 'delete_epic': {
        this.deletedEpics.add(p.epicId);
        for (const task of this.tasks.values()) {
          if (task.epicId === p.epicId) {
            task.epicId = undefined;
          }
        }
        break;
      }
      case 'promote': {
        const task = this.tasks.get(p.taskId);
        if (!task) {
          break;
        }
        const epic = this.ensureEpic(p.epicId, p.title ?? task.title, task.cwd, task.projectKey, 'manual', ev.ts);
        if (task.epicId && this.epics.has(task.epicId)) {
          const old = this.epics.get(task.epicId)!;
          old.taskIds = old.taskIds.filter((id) => id !== task.id);
        }
        task.epicId = epic.id;
        if (!epic.taskIds.includes(task.id)) {
          epic.taskIds.push(task.id);
        }
        break;
      }
      case 'demote': {
        // task -> subtask của parentTaskId
        const task = this.tasks.get(p.taskId);
        const parent = this.tasks.get(p.parentTaskId);
        if (task && parent) {
          const stId = p.subtaskId || `${task.id}-demoted`;
          const st: Subtask = {
            id: stId,
            kind: 'subtask',
            taskId: parent.id,
            title: p.title || task.title,
            status: task.status === 'done' ? 'done' : 'todo',
            source: 'manual',
            createdAt: ev.ts,
          };
          this.subtasks.set(st.id, st);
          if (!parent.subtaskIds.includes(st.id)) {
            parent.subtaskIds.push(st.id);
          }
          this.deletedTasks.add(task.id);
        }
        break;
      }
      case 'toggle_subtask': {
        const st = this.subtasks.get(p.subtaskId);
        if (st) {
          st.status = p.done ? 'done' : 'todo';
        }
        break;
      }
      case 'delete_subtask': {
        this.deletedSubtasks.add(p.subtaskId);
        break;
      }
      case 'delete_task': {
        this.deletedTasks.add(p.taskId);
        break;
      }
      case 'merge': {
        const src = this.tasks.get(p.sourceTaskId);
        const dst = this.tasks.get(p.targetTaskId);
        if (src && dst) {
          for (const t of src.turns) {
            if (!dst.turns.some((x) => x.lineUuid === t.lineUuid)) {
              dst.turns.push(t);
            }
          }
          for (const sid of src.sessionIds) {
            if (!dst.sessionIds.includes(sid)) {
              dst.sessionIds.push(sid);
            }
          }
          for (const sub of src.subtaskIds) {
            const st = this.subtasks.get(sub);
            if (st) {
              st.taskId = dst.id;
            }
            if (!dst.subtaskIds.includes(sub)) {
              dst.subtaskIds.push(sub);
            }
          }
          if (src.createdAt < dst.createdAt) {
            dst.createdAt = src.createdAt;
          }
          if (src.updatedAt > dst.updatedAt) {
            dst.updatedAt = src.updatedAt;
          }
          dst.needsResummarize = true;
          this.deletedTasks.add(src.id);
        }
        break;
      }
      case 'split': {
        const task = this.tasks.get(p.taskId);
        const uuids: string[] = p.turnUuids || [];
        if (task && uuids.length && p.newTaskId) {
          const moved = task.turns.filter((t) => uuids.includes(t.lineUuid));
          if (moved.length) {
            task.turns = task.turns.filter((t) => !uuids.includes(t.lineUuid));
            const newTask: Task = {
              id: p.newTaskId,
              kind: 'task',
              subtaskIds: [],
              projectKey: task.projectKey,
              cwd: task.cwd,
              title: heuristicTitle(moved[0].text),
              summary: '',
              summarySource: 'none',
              lang: task.lang,
              status: 'in_progress',
              createdAt: moved[0].ts,
              updatedAt: moved[moved.length - 1].ts,
              sessionIds: Array.from(new Set(moved.map((m) => m.sessionId))),
              turns: moved,
              tags: [],
              needsResummarize: true,
              summaryFailed: false,
            };
            this.tasks.set(newTask.id, newTask);
          }
        }
        break;
      }
    }
  }

  /** Dọn dẹp item đã xoá + tính lại rollup, gọi sau khi replay xong. */
  finalize(): void {
    for (const id of this.deletedTasks) {
      const task = this.tasks.get(id);
      if (task?.epicId) {
        const epic = this.epics.get(task.epicId);
        if (epic) {
          epic.taskIds = epic.taskIds.filter((x) => x !== id);
        }
      }
      this.tasks.delete(id);
    }
    for (const id of this.deletedEpics) {
      this.epics.delete(id);
    }
    for (const id of this.deletedSubtasks) {
      const st = this.subtasks.get(id);
      if (st) {
        const task = this.tasks.get(st.taskId);
        if (task) {
          task.subtaskIds = task.subtaskIds.filter((x) => x !== id);
        }
      }
      this.subtasks.delete(id);
    }
    // sắp xếp turns + chuẩn hoá thời gian; loại subtaskId không còn tồn tại
    for (const task of this.tasks.values()) {
      task.turns.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
      if (task.turns.length) {
        task.createdAt = task.turns[0].ts;
        const last = task.turns[task.turns.length - 1].ts;
        if (last > task.updatedAt) {
          task.updatedAt = last;
        }
      }
      task.subtaskIds = task.subtaskIds.filter((id) => this.subtasks.has(id));
    }
    for (const epic of this.epics.values()) {
      epic.taskIds = epic.taskIds.filter((id) => this.tasks.has(id));
    }
  }

  // --- truy vấn ---

  getTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  getEpics(): Epic[] {
    return Array.from(this.epics.values());
  }

  getSubtasks(): Subtask[] {
    return Array.from(this.subtasks.values());
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  getEpic(id: string): Epic | undefined {
    return this.epics.get(id);
  }

  getSubtask(id: string): Subtask | undefined {
    return this.subtasks.get(id);
  }

  /** Tiến độ rollup của một Epic. */
  epicProgress(epicId: string): { done: number; total: number } {
    const epic = this.epics.get(epicId);
    if (!epic) {
      return { done: 0, total: 0 };
    }
    let done = 0;
    for (const tid of epic.taskIds) {
      const t = this.tasks.get(tid);
      if (t && t.status === 'done') {
        done++;
      }
    }
    return { done, total: epic.taskIds.length };
  }

  /** Task đang mở gần nhất của một dự án (để gom nhóm lượt mới). */
  openTaskForProject(projectKey: string): Task | undefined {
    let best: Task | undefined;
    for (const task of this.tasks.values()) {
      if (task.projectKey !== projectKey || task.status !== 'in_progress') {
        continue;
      }
      if (!best || task.updatedAt > best.updatedAt) {
        best = task;
      }
    }
    return best;
  }

  /** Mọi task đang mở của một dự án, sắp xếp mới-nhất-trước (để so khớp ngữ nghĩa). */
  openTasksForProject(projectKey: string, limit = 30): Task[] {
    return this.getTasks()
      .filter((t) => t.projectKey === projectKey && t.status === 'in_progress')
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
      .slice(0, limit);
  }
}
