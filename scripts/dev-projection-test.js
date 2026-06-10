// Test thuần cho Projection: tạo task qua event, rồi áp các correction và kiểm kết quả.
const assert = require('assert');
const { randomUUID } = require('crypto');
const { Projection } = require('../out/store/projection.js');

let n = 0;
const id = () => `id-${n++}`;
const ts = (i) => `2026-06-05T0${i}:00:00.000Z`;

function build(events) {
  return Projection.build(events);
}

// 1) Tạo 1 task từ 1 lượt + grouping new
const cwd = 'd:/proj';
const pk = 'd:/proj';
const sid = 's1';
const lu1 = 'u1';
const taskId = 't1';
let log = [
  { type: 'human_turn', eventId: id(), ts: ts(1), sessionId: sid, promptId: 'p1', lineUuid: lu1, cwd, projectKey: pk, text: 'Thêm đăng nhập Google' },
  { type: 'grouping_decision', eventId: id(), ts: ts(1), turnRef: lu1, taskId, decision: 'new', reason: 'heuristic' },
];
let p = build(log);
assert.strictEqual(p.getTasks().length, 1, 'phải có 1 task');
assert.strictEqual(p.getTask(taskId).status, 'in_progress');

// 2) Lượt thứ 2 append
const lu2 = 'u2';
log.push({ type: 'human_turn', eventId: id(), ts: ts(2), sessionId: sid, promptId: 'p2', lineUuid: lu2, cwd, projectKey: pk, text: 'tiếp đi' });
log.push({ type: 'grouping_decision', eventId: id(), ts: ts(2), turnRef: lu2, taskId, decision: 'append', reason: 'heuristic' });
p = build(log);
assert.strictEqual(p.getTasks().length, 1, 'vẫn 1 task sau append');
assert.strictEqual(p.getTask(taskId).turns.length, 2, '2 lượt');

// 3) Classification → epic
const epicId = 'e1';
log.push({ type: 'classification', eventId: id(), ts: ts(2), taskId, epicId, epicTitle: 'Authentication', reason: 'llm', confidence: 0.9 });
p = build(log);
assert.strictEqual(p.getEpics().length, 1);
assert.strictEqual(p.getEpic(epicId).title, 'Authentication');
assert.deepStrictEqual(p.getEpic(epicId).taskIds, [taskId]);

// 4) Subtask + toggle
const stId = 'st1';
log.push({ type: 'subtask', eventId: id(), ts: ts(2), taskId, subtaskId: stId, title: 'Tạo OAuth client', source: 'ai' });
p = build(log);
assert.strictEqual(p.getSubtask(stId).status, 'todo');
log.push({ type: 'correction', eventId: id(), ts: ts(3), op: 'toggle_subtask', payload: { subtaskId: stId, done: true } });
p = build(log);
assert.strictEqual(p.getSubtask(stId).status, 'done', 'subtask done sau toggle');

// 5) set_status done
log.push({ type: 'correction', eventId: id(), ts: ts(3), op: 'set_status', payload: { taskId, status: 'done' } });
p = build(log);
assert.strictEqual(p.getTask(taskId).status, 'done');
assert.deepStrictEqual(p.epicProgress(epicId), { done: 1, total: 1 }, 'rollup epic 1/1');

// 6) Tạo task thứ 2 rồi merge vào task 1
const taskId2 = 't2';
const lu3 = 'u3';
log.push({ type: 'human_turn', eventId: id(), ts: ts(4), sessionId: sid, promptId: 'p3', lineUuid: lu3, cwd, projectKey: pk, text: 'Sửa nút login' });
log.push({ type: 'grouping_decision', eventId: id(), ts: ts(4), turnRef: lu3, taskId: taskId2, decision: 'new', reason: 'heuristic' });
p = build(log);
assert.strictEqual(p.getTasks().length, 2);
log.push({ type: 'correction', eventId: id(), ts: ts(5), op: 'merge', payload: { sourceTaskId: taskId2, targetTaskId: taskId } });
p = build(log);
assert.strictEqual(p.getTasks().length, 1, 'còn 1 task sau merge');
assert.strictEqual(p.getTask(taskId).turns.length, 3, 'task 1 có 3 lượt sau merge');

// 7) delete_task
log.push({ type: 'correction', eventId: id(), ts: ts(6), op: 'delete_task', payload: { taskId } });
p = build(log);
assert.strictEqual(p.getTasks().length, 0, 'xoá task');
assert.strictEqual(p.getEpic(epicId).taskIds.length, 0, 'epic gỡ task đã xoá');

// 8) Idempotent: build lại cùng log cho cùng kết quả
const p2 = build(log);
assert.strictEqual(p2.getTasks().length, 0);

// 9) Idempotency: grouping_decision LẶP cho cùng 1 lượt (khác taskId) → chỉ 1 task
{
  const lu = 'dup-uuid';
  const dupLog = [
    { type: 'human_turn', eventId: id(), ts: ts(1), sessionId: 'sx', promptId: 'px', lineUuid: lu, cwd, projectKey: pk, text: 'Việc bị nạp trùng nhiều lần' },
    { type: 'grouping_decision', eventId: id(), ts: ts(1), turnRef: lu, taskId: 'tA', decision: 'new', reason: 'heuristic' },
    { type: 'grouping_decision', eventId: id(), ts: ts(1), turnRef: lu, taskId: 'tB', decision: 'new', reason: 'heuristic' },
    { type: 'grouping_decision', eventId: id(), ts: ts(1), turnRef: lu, taskId: 'tC', decision: 'new', reason: 'heuristic' },
  ];
  const pp = build(dupLog);
  assert.strictEqual(pp.getTasks().length, 1, 'lượt bị lặp chỉ tạo 1 task');
  assert.ok(pp.getTask('tA'), 'task đầu tiên (tA) được giữ');
  assert.strictEqual(pp.getTask('tA').turns.length, 1, 'tA có đúng 1 lượt (không nhân đôi)');
}

// 10) isNonTaskTurn: lọc lời chào/cảm ơn/xác nhận; KHÔNG lọc câu có nội dung
const { isNonTaskTurn } = require('../out/util.js');
for (const t of ['Hí', 'hi', 'chào bạn', 'cảm ơn nhé', 'ok', 'tiếp đi', '👍', '???', '   ']) {
  assert.strictEqual(isNonTaskTurn(t), true, `phải coi là non-task: "${t}"`);
}
for (const t of [
  'Lỗi nè. Tôi có 1 thắc mắc là mã nguồn đúng rồi mà sao chạy lỗi',
  'Thêm đăng nhập Google',
  'fix giúp tôi lỗi npx',
]) {
  assert.strictEqual(isNonTaskTurn(t), false, `KHÔNG được coi là non-task: "${t}"`);
}

// 11) shouldAutoDeleteFailed: chỉ xoá khi cho phép + bật setting + AI thật + KHÔNG lỗi
{
  const { shouldAutoDeleteFailed } = require('../out/util.js');
  const base = { allow: true, setting: true, aiReady: true, hasError: false };
  assert.strictEqual(shouldAutoDeleteFailed(base), true, 'đủ điều kiện → xoá');
  assert.strictEqual(shouldAutoDeleteFailed({ ...base, hasError: true }), false, 'có lỗi gọi AI → KHÔNG xoá');
  assert.strictEqual(shouldAutoDeleteFailed({ ...base, aiReady: false }), false, 'AI rơi heuristic → KHÔNG xoá');
  assert.strictEqual(shouldAutoDeleteFailed({ ...base, setting: false }), false, 'tắt setting → KHÔNG xoá');
  assert.strictEqual(shouldAutoDeleteFailed({ ...base, allow: false }), false, 'retry (allow=false) → KHÔNG xoá');
}

// 12) buildDailyReport: gom theo DỰ ÁN (khớp checklist), không còn perEpic.
{
  const { buildDailyReport } = require('../out/report/report-builder.js');
  // Dựng mốc theo GIỜ ĐỊA PHƯƠNG để localDateKey không phụ thuộc múi giờ máy chạy test.
  const mk = (h) => new Date(2026, 5, 9, h, 0, 0).toISOString(); // 2026-06-09 local
  const dayKey = '2026-06-09';
  const repLog = [
    { type: 'human_turn', eventId: id(), ts: mk(8), sessionId: 'sa', promptId: 'pa', lineUuid: 'la', cwd: 'd:/proj-a', projectKey: 'd:/proj-a', text: 'Việc thuộc dự án A' },
    { type: 'grouping_decision', eventId: id(), ts: mk(8), turnRef: 'la', taskId: 'rta', decision: 'new', reason: 'heuristic' },
    { type: 'human_turn', eventId: id(), ts: mk(9), sessionId: 'sb', promptId: 'pb', lineUuid: 'lb', cwd: 'd:/proj-b', projectKey: 'd:/proj-b', text: 'Việc thuộc dự án B' },
    { type: 'grouping_decision', eventId: id(), ts: mk(9), turnRef: 'lb', taskId: 'rtb', decision: 'new', reason: 'heuristic' },
    { type: 'subtask', eventId: id(), ts: mk(9), taskId: 'rtb', subtaskId: 'rstb', title: 'Sub B1', source: 'ai' },
    { type: 'correction', eventId: id(), ts: mk(10), op: 'set_status', payload: { taskId: 'rta', status: 'done' } },
  ];
  const rp = build(repLog);
  const report = buildDailyReport(rp, dayKey, new Date(2026, 5, 9, 12, 0, 0));
  assert.ok(!('perEpic' in report), 'báo cáo KHÔNG còn perEpic');
  assert.ok(Array.isArray(report.perProject), 'báo cáo có perProject');
  assert.strictEqual(report.perProject.length, 2, 'gom thành 2 dự án');
  const keys = report.perProject.map((g) => g.projectKey).sort();
  assert.deepStrictEqual(keys, ['d:/proj-a', 'd:/proj-b'], 'đúng 2 projectKey');
  assert.ok(report.perProject.every((g) => typeof g.projectName === 'string' && g.projectName.length > 0), 'mỗi nhóm có projectName');
  const gA = report.perProject.find((g) => g.projectKey === 'd:/proj-a');
  assert.ok(gA.tasksCompleted.includes('rta'), 'task A (done) nằm trong tasksCompleted của dự án A');
  const gB = report.perProject.find((g) => g.projectKey === 'd:/proj-b');
  assert.ok(gB.tasksInProgress.includes('rtb'), 'task B (đang làm) nằm trong tasksInProgress của dự án B');
  assert.strictEqual(report.totals.completed, 1, 'totals: 1 việc xong');

  // 13) computeEffective + reportToMarkdown: lọc task & ẩn/hiện sub-task.
  const { computeEffective, reportToMarkdown } = require('../out/report/report-builder.js');

  // Bất biến: không loại gì → totals khớp đúng buildDailyReport (khoá 2 đường tính tổng lại với nhau).
  const effAll = computeEffective(rp, report, new Set());
  assert.deepStrictEqual(effAll.totals, report.totals, 'invariant: computeEffective rỗng phải khớp report.totals');
  assert.strictEqual(effAll.completedIds.length, report.totals.completed, 'completedIds khớp totals.completed');
  assert.strictEqual(effAll.inProgressIds.length, report.totals.inProgress, 'inProgressIds khớp totals.inProgress');
  assert.strictEqual(effAll.startedIds.length, report.totals.started, 'startedIds khớp totals.started');

  // Loại task rta (việc xong duy nhất) → tổng & số dự án giảm theo.
  const excluded = new Set(['rta']);
  const effEx = computeEffective(rp, report, excluded);
  assert.strictEqual(effEx.totals.completed, 0, 'loại rta → 0 việc xong');
  assert.strictEqual(effEx.totals.inProgress, 1, 'còn rtb đang làm');
  assert.strictEqual(effEx.totals.started, 1, 'còn 1 việc bắt đầu sau khi loại');
  assert.strictEqual(effEx.projectCount, 1, 'chỉ còn dự án B có task được chọn');

  // Markdown phản ánh đúng lựa chọn.
  const mdFull = reportToMarkdown(rp, report);
  assert.ok(mdFull.includes('## proj-a') && mdFull.includes('## proj-b'), 'md đầy đủ có cả 2 dự án');
  assert.ok(mdFull.includes('Sub B1'), 'md mặc định có hiện sub-task');

  const mdEx = reportToMarkdown(rp, report, { excludedTaskIds: excluded });
  assert.ok(!mdEx.includes('## proj-a'), 'md sau khi loại rta → bỏ luôn dự án A trống');
  assert.ok(mdEx.includes('## proj-b'), 'md vẫn còn dự án B');
  assert.ok(mdEx.includes('0 xong'), 'dòng tổng của md phản ánh 0 việc xong');

  const mdNoSub = reportToMarkdown(rp, report, { showSubtasks: false });
  assert.ok(!mdNoSub.includes('Sub B1'), 'tắt sub-task → md không kèm sub-task');

  // 14) Loại cả DỰ ÁN (excludedProjectKeys) → totals + Markdown bỏ hẳn dự án đó.
  const exProj = new Set(['d:/proj-a']);
  const effExProj = computeEffective(rp, report, new Set(), exProj);
  assert.strictEqual(effExProj.totals.completed, 0, 'loại dự án A → 0 việc xong');
  assert.strictEqual(effExProj.totals.inProgress, 1, 'còn rtb của dự án B đang làm');
  assert.strictEqual(effExProj.projectCount, 1, 'chỉ còn 1 dự án sau khi loại dự án A');
  const mdExProj = reportToMarkdown(rp, report, { excludedProjectKeys: exProj });
  assert.ok(!mdExProj.includes('## proj-a'), 'md sau khi loại dự án A → không còn heading proj-a');
  assert.ok(mdExProj.includes('## proj-b'), 'md vẫn còn dự án B');
  assert.ok(mdExProj.includes('0 xong'), 'dòng tổng phản ánh 0 việc xong sau khi loại dự án A');

  // 15) reportToTsv: bảng tab-separated cho Google Sheets, tôn trọng cùng bộ lọc.
  const { reportToTsv } = require('../out/report/report-builder.js');
  const tsv = reportToTsv(rp, report);
  assert.ok(tsv.startsWith('\ufeff'), 'tsv mở đầu bằng BOM UTF-8');
  const tsvLines = tsv.replace(/^\ufeff/, '').trimEnd().split('\n');
  assert.strictEqual(tsvLines[0], 'Ngày\tDự án\tTask\tSub-task\tTrạng thái', 'dòng header đúng 5 cột');
  assert.ok(tsvLines.slice(1).every((l) => l.split('\t').length === 5), 'mọi dòng dữ liệu đủ 5 cột');
  assert.ok(tsvLines.some((l) => l.includes('proj-a') && l.endsWith('Đã xong')), 'task done của dự án A có trạng thái Đã xong');
  assert.ok(tsvLines.some((l) => l.includes('Sub B1')), 'tsv mặc định kèm dòng sub-task');
  const tsvNoSub = reportToTsv(rp, report, { showSubtasks: false });
  assert.ok(!tsvNoSub.includes('Sub B1'), 'tắt sub-task → tsv không kèm sub-task');
  const tsvExProj = reportToTsv(rp, report, { excludedProjectKeys: exProj });
  assert.ok(!tsvExProj.includes('proj-a'), 'loại dự án A → tsv không còn dòng nào của proj-a');
  const tsvExTask = reportToTsv(rp, report, { excludedTaskIds: new Set(['rta']) });
  assert.ok(!tsvExTask.split('\n').some((l) => l.includes('proj-a')), 'loại task rta → mất dòng task (và sub) của nó');
}

console.log('[projection-test] OK — tất cả assertion qua.');
