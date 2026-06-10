// Test tích hợp: "Dựng lại toàn bộ task" phải KHÔI PHỤC trạng thái check
// (task done + subtask done) sang các task được dựng lại với id mới, map qua lineUuid.
// Dùng engine heuristic (useAi=false) nên không cần Copilot/API key.
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const Module = require('module');

class EventEmitter {
  constructor() {
    this._l = new Set();
    this.event = (fn) => { this._l.add(fn); return { dispose: () => this._l.delete(fn) }; };
  }
  fire(d) { for (const l of this._l) { try { l(d); } catch { /* ignore */ } } }
  dispose() { this._l.clear(); }
}

// autoCapture TẮT để KHÔNG khởi động watcher đọc transcript thật của máy.
const cfg = { 'autoCapture.enabled': false };
const configuration = {
  get(key, fallback) { return Object.prototype.hasOwnProperty.call(cfg, key) ? cfg[key] : fallback; },
  async update() {},
};
const mockVscode = {
  EventEmitter,
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  workspace: {
    workspaceFolders: [],
    getConfiguration() { return configuration; },
    onDidChangeConfiguration() { return { dispose() {} }; },
  },
  window: { createOutputChannel() { return { appendLine() {}, dispose() {} }; } },
};

const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'vscode') { return mockVscode; }
  return originalLoad.call(this, request, parent, isMain);
};

const cwd = 'd:/proj-reprocess';
const pk = cwd;
function turn(lineUuid, sessionId, text, ts) {
  return { type: 'human_turn', eventId: lineUuid, ts, sessionId, promptId: `p-${lineUuid}`, lineUuid, cwd, projectKey: pk, text };
}

async function main() {
  try {
    const { TaskMindService } = require('../out/capture/task-mind-service.js');
    const storage = path.resolve(__dirname, '..', '.tmp-reprocess-storage');
    try { fs.rmSync(storage, { recursive: true, force: true }); } catch { /* ignore */ }
    const context = {
      globalStorageUri: { fsPath: storage },
      subscriptions: [],
      secrets: { get: async () => undefined, store: async () => {} },
    };

    const svc = new TaskMindService(storage, context);
    await svc.start();

    // Seed RAW: 2 việc khác chủ đề (khác session → tách task) + 1 agent_todo cho việc A.
    await svc.append([
      turn('ra-uA', 'ra-sA', 'Thêm đăng nhập bằng Google cho trang quản trị nội bộ', '2026-06-01T01:00:00.000Z'),
      { type: 'agent_todo', eventId: 'ra-todoA', ts: '2026-06-01T01:01:00.000Z', sessionId: 'ra-sA', cwd, todos: [{ content: 'Tạo OAuth client Google', status: 'pending' }] },
      turn('ra-uB', 'ra-sB', 'Tối ưu truy vấn báo cáo doanh thu hằng tháng bị chậm', '2026-06-01T02:00:00.000Z'),
    ]);

    // Lần dựng đầu: tạo task A (kèm subtask từ agent_todo) và task B.
    await svc.reprocess(false, undefined, { keepAllHistory: true });
    let proj = svc.getProjection();
    const taskA = proj.getTasks().find((t) => t.turns.some((x) => x.lineUuid === 'ra-uA'));
    const taskB = proj.getTasks().find((t) => t.turns.some((x) => x.lineUuid === 'ra-uB'));
    assert.ok(taskA && taskB, 'phải dựng được task A và task B');
    assert.notStrictEqual(taskA.id, taskB.id, 'A và B phải là 2 task riêng');
    assert.strictEqual(taskA.subtaskIds.length, 1, 'task A phải có 1 subtask từ agent_todo');
    const subId = taskA.subtaskIds[0];

    // Người dùng check: việc A xong + subtask của A xong.
    await svc.applyCorrection('set_status', { taskId: taskA.id, status: 'done' });
    await svc.applyCorrection('toggle_subtask', { subtaskId: subId, done: true });
    proj = svc.getProjection();
    assert.strictEqual(proj.getTask(taskA.id).status, 'done', 'tiền đề: A đang done');
    assert.strictEqual(proj.getSubtask(subId).status, 'done', 'tiền đề: subtask A đang done');

    // backfillDays mặc định = 1 → reprocessImpact phải báo 2 việc (dữ liệu cũ) sẽ bị cắt nếu KHÔNG keepAll.
    assert.strictEqual(svc.reprocessImpact().droppedTasks, 2, 'cảnh báo: 2 việc ngày cũ sẽ bị cắt');

    // === HÀNH ĐỘNG: lỡ bấm "Dựng lại toàn bộ" (giữ toàn bộ lịch sử) ===
    const res = await svc.reprocess(false, undefined, { keepAllHistory: true });

    proj = svc.getProjection();
    const newA = proj.getTasks().find((t) => t.turns.some((x) => x.lineUuid === 'ra-uA'));
    const newB = proj.getTasks().find((t) => t.turns.some((x) => x.lineUuid === 'ra-uB'));
    assert.ok(newA && newB, 'sau dựng lại vẫn còn A và B (keepAllHistory)');
    assert.notStrictEqual(newA.id, taskA.id, 'task A phải có ID MỚI sau dựng lại');

    // Trạng thái check được khôi phục đúng:
    assert.strictEqual(newA.status, 'done', 'A: trạng thái done được khôi phục');
    assert.strictEqual(newB.status, 'in_progress', 'B: KHÔNG bị đánh done nhầm (chưa từng check)');

    const newSub = newA.subtaskIds
      .map((id) => proj.getSubtask(id))
      .find((s) => s && s.title.trim().toLowerCase() === 'tạo oauth client google');
    assert.ok(newSub, 'subtask của A được tái tạo từ agent_todo');
    assert.strictEqual(newSub.status, 'done', 'subtask A: trạng thái done được khôi phục');

    // Báo cáo kết quả khớp:
    assert.ok((res.restored ?? 0) >= 1, 'res.restored phải >= 1');
    assert.ok((res.restoredSubtasks ?? 0) >= 1, 'res.restoredSubtasks phải >= 1');
    assert.strictEqual(res.droppedByCutoff, 0, 'keepAllHistory → không cắt việc nào');

    svc.dispose();
    try { fs.rmSync(storage, { recursive: true, force: true }); } catch { /* ignore */ }
    console.log('[reprocess-test] OK — khôi phục check task & subtask qua dựng lại; cảnh báo cắt cửa sổ đúng.');
  } finally {
    Module._load = originalLoad;
  }
}

main().catch((e) => {
  console.error('[reprocess-test] FAILED');
  console.error(e);
  process.exit(1);
});
