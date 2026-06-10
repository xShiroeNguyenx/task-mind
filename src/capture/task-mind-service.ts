import * as vscode from 'vscode';
import { BaseCaptureService } from './capture-service';
import { TranscriptWatcher } from './transcript-watcher';
import { AiEngine } from '../brain/ai-engine';
import { decideGrouping } from '../brain/grouping';
import { classifyTask, decomposeSubtasks, subtasksFromTodos } from '../brain/classifier';
import { readConfig } from '../config';
import { CaptureEvent, HumanTurnEvent, SummaryEvent, Subtask, Task, TaskStatus } from '../types';
import { heuristicSummary, heuristicTitle, isNonTaskTurn, projectNameFromCwd, shouldAutoDeleteFailed } from '../util';
import { log } from '../log';

function nowIso(): string {
  return new Date().toISOString();
}

const SUMMARIZE_DEBOUNCE_MS = 4000;

/**
 * Dịch vụ thật: TranscriptWatcher → ingest pipeline (gom nhóm → phân loại → subtask →
 * tóm tắt) → event log. Quyết định (grouping/classification/summary) được ghi thành
 * event nên projection chỉ là phát lại thuần.
 */
export class TaskMindService extends BaseCaptureService {
  private watcher: TranscriptWatcher | undefined;
  private ai: AiEngine;
  private readonly heuristicAi: AiEngine;
  private readonly summarizeTimers = new Map<string, NodeJS.Timeout>();
  /** Có dùng AI cho lượt hiện tại không (backfill = false để tránh bùng nổ gọi AI). */
  private aiEnabledNow = false;
  /** Có lên lịch tóm tắt (debounce) không — chỉ ở luồng live. */
  private scheduleSummaries = false;
  /** Trong backfill, bỏ qua các lượt cũ hơn mốc này (giới hạn N ngày). undefined = không giới hạn. */
  private backfillCutoffIso: string | undefined;
  /** Task ⚠️ "thiếu thông tin" chờ auto-xoá sau vòng reprocess (chỉ xoá nếu run có ≥1 tên AI). */
  private readonly autoDeleteCandidates = new Set<string>();

  constructor(
    storageDir: string,
    private readonly context: vscode.ExtensionContext,
  ) {
    super(storageDir);
    this.ai = this.buildEngine();
    this.heuristicAi = new AiEngine({
      provider: 'heuristic',
      externalProvider: 'anthropic',
      model: '',
      getApiKey: async () => undefined,
    });
  }

  private buildEngine(): AiEngine {
    const cfg = readConfig();
    return new AiEngine({
      provider: cfg.aiProvider,
      externalProvider: cfg.externalProvider,
      model: cfg.aiModel,
      getApiKey: () => Promise.resolve(this.context.secrets.get(`taskMind.apiKey.${cfg.externalProvider}`)),
    });
  }

  /** Engine dùng cho lượt hiện tại: heuristic khi backfill/tắt AI, AI thật khi bật. */
  private get engine(): AiEngine {
    return this.aiEnabledNow ? this.ai : this.heuristicAi;
  }

  /** Gọi khi cấu hình AI / key đổi. */
  reconfigure(): void {
    this.ai = this.buildEngine();
  }

  /** Kiểm tra AI: resolve engine + gọi thử 1 lần summarize để xác nhận thật sự chạy. */
  async aiStatus(): Promise<{ engine: string; ok: boolean; sample?: string; error?: string }> {
    this.ai = this.buildEngine();
    this.ai.reset();
    const engine = await this.ai.resolvedName();
    if (engine === 'heuristic') {
      return { engine, ok: false, error: 'Không resolve được model nào (chưa có Copilot và chưa có/không hợp lệ API key).' };
    }
    try {
      const res = await this.ai.summarize(
        ['Người dùng đâu hiểu, fix lỗi npx khi cài package giúp tôi đi'],
        [],
        'DemoApp',
      );
      if (res && res.title) {
        return { engine, ok: true, sample: res.title };
      }
    } catch (e) {
      return { engine, ok: false, error: String(e) };
    }
    return { engine, ok: false, error: this.ai.lastError() };
  }

  /** Mốc ISO của "N ngày trước" (đầu ngày địa phương). undefined nếu days<=0. */
  private cutoffIso(days: number): string | undefined {
    if (!days || days <= 0) {
      return undefined;
    }
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (days - 1)); // days=2 → hôm nay + hôm qua
    return d.toISOString();
  }

  protected async onStart(): Promise<void> {
    const cfg = readConfig();
    if (!cfg.autoCaptureEnabled) {
      log('autoCapture tắt — không khởi động watcher.');
      this.aiEnabledNow = true;
      this.scheduleSummaries = true;
      return;
    }
    this.backfillCutoffIso = this.cutoffIso(cfg.backfillDays);
    this.watcher = new TranscriptWatcher(
      this.log.dir,
      (events) => this.ingestBatch(events),
      () => this.newId(),
      undefined,
      () => {
        this.aiEnabledNow = true;
        this.scheduleSummaries = true;
        this.backfillCutoffIso = undefined; // hết backfill: lượt live (hôm nay/tương lai) luôn nhận
        log('Backfill lịch sử xong — chuyển sang AI thật cho lượt mới.');
      },
    );
    // KHÔNG await: để activate() trả về ngay, lần quét đầu (backfill) chạy nền.
    void this.watcher.start(cfg.pollIntervalSeconds);
    log('TranscriptWatcher đang khởi động (quét nền).');
  }

  dispose(): void {
    void this.watcher?.stop();
    for (const t of this.summarizeTimers.values()) {
      clearTimeout(t);
    }
    this.summarizeTimers.clear();
    super.dispose();
  }

  /** Nạp một batch event đã parse từ transcript (áp tăng dần, finalize 1 lần/batch). */
  private async ingestBatch(events: CaptureEvent[]): Promise<void> {
    const sorted = [...events].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    const cutoff = this.backfillCutoffIso;
    let mutated = false;
    for (const ev of sorted) {
      // Trong backfill: bỏ qua mọi event cũ hơn cửa sổ N ngày (giữ log gọn, tập trung gần đây).
      if (cutoff && ev.ts < cutoff) {
        continue;
      }
      if (ev.type === 'human_turn') {
        if (this.projection.hasProcessedTurn(ev.lineUuid)) {
          continue;
        }
        await this.logAndApply(ev);
        await this.handleHumanTurn(ev);
        mutated = true;
      } else {
        await this.logAndApply(ev);
        mutated = true;
      }
    }
    if (mutated) {
      this.finalizeAndFire();
    }
  }

  private async handleHumanTurn(turn: HumanTurnEvent): Promise<void> {
    const cfg = readConfig();
    // So khớp với MỌI task đang mở của dự án (mới nhất trước), không chỉ task gần nhất.
    const candidates = this.projection.openTasksForProject(turn.projectKey, 30);
    const grouping = await decideGrouping(
      turn.text,
      turn.ts,
      turn.sessionId,
      candidates,
      cfg.idleGapMinutes,
      this.engine,
      !this.aiEnabledNow, // chỉ cho heuristic gom nhóm khi KHÔNG dùng AI
    );
    // Lượt rõ ràng không phải việc (chào hỏi, cảm ơn, xác nhận lẻ) mà KHÔNG nối được vào
    // task đang mở → bỏ qua, không tạo task rác. human_turn vẫn nằm trong log (đã processed)
    // nên không bị xử lại; chỉ là không sinh grouping_decision → không có task/dòng ma.
    // Lượt nối tiếp trong task đang mở (decision === 'append') KHÔNG bị ảnh hưởng.
    if (grouping.decision !== 'append' && isNonTaskTurn(turn.text)) {
      log(`Bỏ qua lượt non-task (không tạo task mới): "${turn.text.slice(0, 40)}"`);
      return;
    }
    const taskId =
      grouping.decision === 'append' && grouping.taskId ? grouping.taskId : this.newId();
    await this.logAndApply({
      type: 'grouping_decision',
      eventId: this.newId(),
      ts: turn.ts,
      turnRef: turn.lineUuid,
      taskId,
      decision: grouping.decision,
      reason: grouping.reason,
      confidence: grouping.confidence,
    });

    const task = this.projection.getTask(taskId);
    if (!task) {
      return;
    }
    await this.classifyAndAttach(task, cfg.autoClassify);
    await this.maybeSubtasks(task, turn.sessionId, cfg.subtaskSource);
    if (this.scheduleSummaries) {
      this.scheduleSummarize(taskId);
    }
  }

  private async classifyAndAttach(task: Task, autoClassify: boolean): Promise<void> {
    if (!autoClassify || task.epicId) {
      return;
    }
    const epics = this.projection
      .getEpics()
      .filter((e) => e.projectKey === task.projectKey)
      .map((e) => ({ id: e.id, title: e.title }));
    const taskText = `${task.title}. ${task.turns.map((t) => t.text).join(' ')}`.slice(0, 1000);
    const dec = await classifyTask({
      taskText,
      existingEpics: epics,
      ai: this.engine,
      autoClassify,
      newEpicId: () => `epic-${this.newId()}`,
    });
    if (dec) {
      await this.logAndApply({
        type: 'classification',
        eventId: this.newId(),
        ts: nowIso(),
        taskId: task.id,
        epicId: dec.epicId,
        epicTitle: dec.epicTitle,
        reason: dec.reason,
        confidence: dec.confidence,
      });
    }
  }

  private async maybeSubtasks(task: Task, sessionId: string, source: string): Promise<void> {
    if (source === 'off') {
      return;
    }
    const events: CaptureEvent[] = [];
    const existingTitles = new Set(
      task.subtaskIds
        .map((id) => this.projection.getSubtask(id)?.title.toLowerCase())
        .filter(Boolean) as string[],
    );

    if (source === 'agent-todo' || source === 'both') {
      const todos = this.projection.latestTodos.get(sessionId);
      if (todos?.length) {
        for (const s of subtasksFromTodos(todos)) {
          if (!existingTitles.has(s.title.toLowerCase())) {
            existingTitles.add(s.title.toLowerCase());
            events.push({
              type: 'subtask',
              eventId: this.newId(),
              ts: nowIso(),
              taskId: task.id,
              subtaskId: this.newId(),
              title: s.title,
              source: 'agent-todo',
              done: s.done,
            });
          }
        }
      }
    }

    const wantAi = source === 'ai' || (source === 'both' && events.length === 0);
    if (wantAi && task.subtaskIds.length === 0) {
      const taskText = `${task.title}. ${task.turns.map((t) => t.text).join(' ')}`.slice(0, 1000);
      const subs = await decomposeSubtasks(taskText, this.engine);
      for (const title of subs) {
        if (!existingTitles.has(title.toLowerCase())) {
          existingTitles.add(title.toLowerCase());
          events.push({
            type: 'subtask',
            eventId: this.newId(),
            ts: nowIso(),
            taskId: task.id,
            subtaskId: this.newId(),
            title,
            source: 'ai',
          });
        }
      }
    }

    for (const ev of events) {
      await this.logAndApply(ev);
    }
  }

  private scheduleSummarize(taskId: string): void {
    const existing = this.summarizeTimers.get(taskId);
    if (existing) {
      clearTimeout(existing);
    }
    this.summarizeTimers.set(
      taskId,
      setTimeout(() => void this.summarizeNow(taskId), SUMMARIZE_DEBOUNCE_MS),
    );
  }

  private async summarizeNow(
    taskId: string,
    fire = true,
    force = false,
    allowAutoDelete = true,
  ): Promise<'lm' | 'heuristic' | 'failed' | 'deleted' | undefined> {
    this.summarizeTimers.delete(taskId);
    const task = this.projection.getTask(taskId);
    if (!task || (!task.needsResummarize && !force)) {
      return undefined;
    }
    const human = task.turns.map((t) => t.text);
    const assistant = task.turns.map((t) => t.assistantExcerpt).filter(Boolean) as string[];

    let title: string;
    let summary: string;
    let src: SummaryEvent['source'];
    let failed = false;

    const res = await this.engine.summarize(human, assistant, projectNameFromCwd(task.cwd));
    if (res) {
      title = res.title || heuristicTitle(human[0] ?? '');
      summary = res.summary || '';
      src = 'lm';
    } else if (this.aiEnabledNow) {
      // AI bật mà không đặt được tên. Phân biệt 2 nguyên nhân:
      //  - CÓ lastError (network/429/sai key…) = lỗi tạm thời → giữ ⚠️ để người dùng retry.
      //  - KHÔNG lastError = AI đã trả lời nhưng nội dung quá mỏng → "thiếu thông tin".
      // An toàn: chỉ auto-xoá khi engine LÀ AI thật. Nếu rơi về heuristic (AI không khả dụng,
      // client=undefined) thì summarize() trả undefined mà KHÔNG có lastError → tuyệt đối
      // KHÔNG được tự xoá (sẽ xoá sạch mọi task). aiReady=false → coi như lỗi, giữ ⚠️.
      const aiReady = (await this.engine.resolvedName()) !== 'heuristic';
      const hasError = !!this.engine.lastError();
      const setting = readConfig().autoDeleteFailedTasks;
      if (shouldAutoDeleteFailed({ allow: allowAutoDelete, setting, aiReady, hasError })) {
        // Luồng live: xoá ngay (blast radius = 1 task).
        await this.logAndApply({
          type: 'correction',
          op: 'delete_task',
          payload: { taskId },
          eventId: this.newId(),
          ts: nowIso(),
        });
        if (fire) {
          this.finalizeAndFire();
        }
        log(`Tự xoá task thiếu thông tin (AI trả lời nhưng không đặt được tên): ${taskId}`);
        return 'deleted';
      }
      // Reprocess (allow=false): ghi nhận để XOÁ SAU vòng lặp — và chỉ khi run đó có ≥1 task được
      // AI đặt tên (guard chống model hỏng trả prose cho mọi task → xoá sạch).
      if (!allowAutoDelete && shouldAutoDeleteFailed({ allow: true, setting, aiReady, hasError })) {
        this.autoDeleteCandidates.add(taskId);
      }
      // Không tự xoá → KHÔNG chế tên heuristic. Gắn cờ fail, giữ prompt thô làm nhãn tạm.
      title = `⚠️ ${heuristicTitle(human[0] ?? task.title)}`;
      summary = '';
      src = 'heuristic';
      failed = true;
    } else {
      // Không có AI cấu hình → heuristic là lựa chọn duy nhất.
      title = heuristicTitle(human[0] ?? task.title);
      summary = heuristicSummary(human);
      src = 'heuristic';
    }

    await this.logAndApply({
      type: 'summary',
      eventId: this.newId(),
      ts: nowIso(),
      targetId: taskId,
      targetKind: 'task',
      title,
      summary,
      lang: 'vi',
      source: src,
      failed,
    });
    if (fire) {
      this.finalizeAndFire();
    }
    return failed ? 'failed' : src === 'lm' ? 'lm' : 'heuristic';
  }

  /** Xoá mọi task AI không đặt được tên (cờ ⚠️). Trả số task đã xoá. */
  async deleteFailedTasks(fire = true): Promise<number> {
    const failed = this.projection.getTasks().filter((t) => t.summaryFailed);
    for (const f of failed) {
      await this.logAndApply({
        type: 'correction',
        op: 'delete_task',
        payload: { taskId: f.id },
        eventId: this.newId(),
        ts: nowIso(),
      });
    }
    if (failed.length && fire) {
      this.finalizeAndFire();
    }
    return failed.length;
  }

  /** Dựng lại tên/tóm tắt cho MỘT task bằng AI (task bị cờ fail). */
  async retryTask(taskId: string): Promise<{ ok: boolean; engine: string; error?: string }> {
    this.ai = this.buildEngine();
    this.ai.reset();
    const engine = await this.ai.resolvedName();
    const prev = this.aiEnabledNow;
    this.aiEnabledNow = true;
    try {
      const src = await this.summarizeNow(taskId, true, true, false); // retry: KHÔNG tự xoá
      this.finalizeAndFire();
      return { ok: src === 'lm', engine, error: src === 'lm' ? undefined : this.ai.lastError() };
    } finally {
      this.aiEnabledNow = prev;
    }
  }

  /**
   * Dựng lại toàn bộ task: giữ các event GỐC (lượt người, phản hồi, todo), bỏ các event
   * suy diễn cũ (gom nhóm/phân loại/tóm tắt/correction), rồi chạy lại pipeline gom nhóm
   * với thuật toán so khớp ngữ nghĩa hiện tại. An toàn nhờ EventLog.replaceAll có backup.
   */
  async reprocess(
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
  }> {
    // Build LẠI engine từ cấu hình + key hiện tại (tránh dùng this.ai cũ/lỗi thời).
    if (useAi) {
      this.ai = this.buildEngine();
      this.ai.reset();
    }

    // Chụp trạng thái thủ công (check việc + subtask hoàn thành) TRƯỚC khi xoá log — task được
    // dựng lại với id MỚI nên phải khôi phục bằng cách map qua lineUuid của turn (turn ổn định).
    const oldSnap = this.projection.getTasks().map((t) => ({
      turns: t.turns.map((x) => x.lineUuid),
      status: t.status,
      doneSubtasks: t.subtaskIds
        .map((id) => this.projection.getSubtask(id))
        .filter((s): s is Subtask => !!s && s.status === 'done')
        .map((s) => s.title.trim().toLowerCase()),
    }));
    // keepAllHistory: bỏ cắt cửa sổ N ngày để KHÔNG mất task ngày cũ (nhờ đó mới khôi phục được check).
    const keepAll = opts?.keepAllHistory ?? false;
    const droppedByCutoff = keepAll ? 0 : this.reprocessImpact().droppedTasks;

    const RAW = new Set(['human_turn', 'assistant_text', 'session_meta', 'agent_todo']);
    const cutoff = keepAll ? undefined : this.cutoffIso(readConfig().backfillDays);
    // Giữ event gốc trong cửa sổ N ngày; bỏ dữ liệu cũ hơn (trọng tâm hôm nay + gần đây).
    const rawAll = this.log.getAll().filter((e) => RAW.has(e.type) && (!cutoff || e.ts >= cutoff));
    // Khử trùng dữ liệu gốc (chống lượt cũ bị nạp lặp nhiều lần):
    //  - human_turn: giữ bản SỚM NHẤT theo lineUuid (sort theo ts từ trước) → 1 lượt = 1 task.
    //  - session_meta / agent_todo: chỉ giữ bản MỚI NHẤT mỗi session (đằng nào projection cũng
    //    chỉ dùng bản cuối) → rút gọn log phình to.
    const metaTotal = new Map<string, number>();
    const todoTotal = new Map<string, number>();
    for (const e of rawAll) {
      if (e.type === 'session_meta') metaTotal.set(e.sessionId, (metaTotal.get(e.sessionId) ?? 0) + 1);
      else if (e.type === 'agent_todo') todoTotal.set(e.sessionId, (todoTotal.get(e.sessionId) ?? 0) + 1);
    }
    const seenTurn = new Set<string>();
    const metaSeen = new Map<string, number>();
    const todoSeen = new Map<string, number>();
    const raw = rawAll.filter((e) => {
      if (e.type === 'human_turn') {
        if (seenTurn.has(e.lineUuid)) return false;
        seenTurn.add(e.lineUuid);
      } else if (e.type === 'session_meta') {
        const n = (metaSeen.get(e.sessionId) ?? 0) + 1;
        metaSeen.set(e.sessionId, n);
        if (n < (metaTotal.get(e.sessionId) ?? 0)) return false; // bỏ tất cả trừ bản cuối
      } else if (e.type === 'agent_todo') {
        const n = (todoSeen.get(e.sessionId) ?? 0) + 1;
        todoSeen.set(e.sessionId, n);
        if (n < (todoTotal.get(e.sessionId) ?? 0)) return false;
      }
      return true;
    });

    for (const t of this.summarizeTimers.values()) {
      clearTimeout(t);
    }
    this.summarizeTimers.clear();

    await this.log.replaceAll(raw);
    this.rebuild(); // projection = build từ raw (0 task, nhưng rawTurns đã có)

    const prevAi = this.aiEnabledNow;
    const prevSched = this.scheduleSummaries;
    this.aiEnabledNow = useAi;
    this.scheduleSummaries = false; // tự tóm tắt cuối, không debounce

    const engineName = await this.engine.resolvedName();
    let lastErr: string | undefined;
    let autoDeleted = 0;
    this.autoDeleteCandidates.clear();

    try {
      const turns = raw
        .filter((e): e is HumanTurnEvent => e.type === 'human_turn')
        .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
      let i = 0;
      for (const turn of turns) {
        await this.handleHumanTurn(turn);
        onProgress?.(`Gom nhóm ${++i}/${turns.length}`);
      }
      const tasks = this.projection.getTasks();
      let j = 0;
      for (const task of tasks) {
        // allowAutoDelete=false: KHÔNG xoá ngay trong vòng lặp; gom candidate để xoá sau khi
        // biết cả run (cần ≥1 tên AI mới tin tưởng xoá).
        await this.summarizeNow(task.id, false, false, false);
        onProgress?.(`Đặt tên ${++j}/${tasks.length}`);
      }
      lastErr = this.ai.lastError();
    } finally {
      this.aiEnabledNow = prevAi;
      this.scheduleSummaries = prevSched;
      this.finalizeAndFire();
    }

    // Sweep auto-xoá có GUARD: chỉ xoá khi run này có ≥1 task được AI đặt tên (titledByAi > 0).
    // Nếu model trả prose/không parse được tiêu đề cho MỌI task → titledByAi=0 → KHÔNG xoá gì
    // (chống xoá sạch do model hỏng). Candidate đã loại sẵn trường hợp lỗi gọi AI / heuristic.
    const titledByAi = this.projection.getTasks().filter((t) => !t.summaryFailed && t.summarySource === 'lm').length;
    if (readConfig().autoDeleteFailedTasks && titledByAi > 0 && this.autoDeleteCandidates.size) {
      for (const id of this.autoDeleteCandidates) {
        const t = this.projection.getTask(id);
        if (t && t.summaryFailed) {
          await this.logAndApply({
            type: 'correction',
            op: 'delete_task',
            payload: { taskId: id },
            eventId: this.newId(),
            ts: nowIso(),
          });
          autoDeleted++;
        }
      }
      if (autoDeleted) {
        this.finalizeAndFire();
      }
    }
    this.autoDeleteCandidates.clear();

    // Khôi phục trạng thái check (done/abandoned việc + subtask) lên các task vừa dựng lại.
    const restored = await this.restoreStatuses(oldSnap);

    // Task ⚠️ còn lại = lỗi gọi AI tạm thời (giữ để retry). "thiếu thông tin" thật đã auto-xoá.
    const finalTasks = this.projection.getTasks();
    const aiTitles = finalTasks.filter((t) => !t.summaryFailed && t.summarySource === 'lm').length;
    const heuristic = finalTasks.filter((t) => !t.summaryFailed && t.summarySource === 'heuristic').length;
    const failed = finalTasks.filter((t) => t.summaryFailed).length;

    return {
      tasks: finalTasks.length,
      engine: engineName,
      aiTitles,
      heuristic,
      failed,
      autoDeleted,
      restored: restored.tasks,
      restoredSubtasks: restored.subtasks,
      droppedByCutoff,
      error: failed > 0 ? lastErr : undefined,
    };
  }

  /** Ước lượng tác động reprocess: số việc sẽ bị cắt bởi cửa sổ backfillDays (0 nếu backfillDays<=0). */
  reprocessImpact(): { droppedTasks: number; backfillDays: number } {
    const days = readConfig().backfillDays;
    const cutoff = this.cutoffIso(days);
    if (!cutoff) {
      return { droppedTasks: 0, backfillDays: days };
    }
    const droppedTasks = this.projection.getTasks().filter((t) => {
      const newest = t.turns.reduce((m, x) => (x.ts > m ? x.ts : m), '');
      return !!newest && newest < cutoff;
    }).length;
    return { droppedTasks, backfillDays: days };
  }

  /**
   * Khôi phục trạng thái thủ công sau khi dựng lại: task done/abandoned + subtask done.
   * Map qua lineUuid của turn (id task/subtask đã đổi). Bảo thủ với task: chỉ đặt lại trạng thái
   * khi MỌI turn của task mới cùng thuộc một trạng thái cũ (gộp done + đang-làm → giữ in_progress,
   * tránh báo "xong" nhầm). Subtask: map task cũ → task mới theo đa số turn trùng, khớp theo tiêu đề
   * (agent-todo tái tạo y tiêu đề nên khớp được; tiêu đề AI chẻ ngẫu nhiên có thể không khớp — chấp nhận).
   */
  private async restoreStatuses(
    oldSnap: Array<{ turns: string[]; status: TaskStatus; doneSubtasks: string[] }>,
  ): Promise<{ tasks: number; subtasks: number }> {
    if (!oldSnap.length) {
      return { tasks: 0, subtasks: 0 };
    }
    const turnToNew = new Map<string, string>();
    for (const t of this.projection.getTasks()) {
      for (const tr of t.turns) {
        turnToNew.set(tr.lineUuid, t.id);
      }
    }
    // Mỗi turn thuộc đúng 1 task cũ → 2 tập rời nhau.
    const byStatus: Record<'done' | 'abandoned', Set<string>> = { done: new Set(), abandoned: new Set() };
    for (const s of oldSnap) {
      if (s.status === 'done' || s.status === 'abandoned') {
        for (const lu of s.turns) {
          byStatus[s.status].add(lu);
        }
      }
    }
    const events: CaptureEvent[] = [];
    let tasks = 0;
    for (const t of this.projection.getTasks()) {
      if (!t.turns.length) {
        continue;
      }
      const lus = t.turns.map((x) => x.lineUuid);
      let target: TaskStatus | undefined;
      if (lus.every((l) => byStatus.done.has(l))) {
        target = 'done';
      } else if (lus.every((l) => byStatus.abandoned.has(l))) {
        target = 'abandoned';
      }
      if (target && t.status !== target) {
        events.push({ type: 'correction', op: 'set_status', payload: { taskId: t.id, status: target }, eventId: this.newId(), ts: nowIso() });
        tasks++;
      }
    }
    let subtasks = 0;
    for (const s of oldSnap) {
      if (!s.doneSubtasks.length) {
        continue;
      }
      const counts = new Map<string, number>();
      for (const lu of s.turns) {
        const nt = turnToNew.get(lu);
        if (nt) {
          counts.set(nt, (counts.get(nt) ?? 0) + 1);
        }
      }
      let bestId: string | undefined;
      let bestN = 0;
      for (const [id, n] of counts) {
        if (n > bestN) {
          bestN = n;
          bestId = id;
        }
      }
      if (!bestId) {
        continue;
      }
      const nt = this.projection.getTask(bestId);
      if (!nt) {
        continue;
      }
      const want = new Set(s.doneSubtasks);
      for (const sid of nt.subtaskIds) {
        const st = this.projection.getSubtask(sid);
        if (st && st.status !== 'done' && want.has(st.title.trim().toLowerCase())) {
          events.push({ type: 'correction', op: 'toggle_subtask', payload: { subtaskId: sid, done: true }, eventId: this.newId(), ts: nowIso() });
          subtasks++;
        }
      }
    }
    for (const ev of events) {
      await this.logAndApply(ev);
    }
    if (events.length) {
      this.finalizeAndFire();
    }
    return { tasks, subtasks };
  }
}
