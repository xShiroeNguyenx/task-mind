// Script dev tạm: chạy pipeline (parse → group → classify) trên transcript Claude Code
// THẬT để kiểm tra heuristic. Mock 'vscode' = {} vì chỉ dùng module thuần.
const Module = require('module');
const orig = Module._load;
Module._load = (r, p, m) => (r === 'vscode' ? {} : orig.call(Module, r, p, m));

const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');

const { parseTranscriptLine } = require('../out/capture/line-parser.js');
const { Projection } = require('../out/store/projection.js');
const { decideGrouping } = require('../out/brain/grouping.js');
const { classifyTask } = require('../out/brain/classifier.js');

const ai = {
  async judgeSameTask() { return undefined; },
  async classifyEpic() { return undefined; },
  async decompose() { return undefined; },
  async summarize() { return undefined; },
  async matchTask() { return undefined; },
  async resolvedName() { return 'heuristic'; },
};

function newId() { return randomUUID(); }

async function main() {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const dirs = fs.readdirSync(root).filter((d) => {
    try { return fs.statSync(path.join(root, d)).isDirectory(); } catch { return false; }
  });
  // chọn project có file .jsonl lớn nhất
  let best = null;
  for (const d of dirs) {
    const dir = path.join(root, d);
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
      const full = path.join(dir, f);
      const size = fs.statSync(full).size;
      if (!best || size > best.size) best = { full, size };
    }
  }
  if (!best) { console.log('Không tìm thấy transcript.'); return; }
  console.log('Transcript:', best.full, `(${best.size} bytes)`);

  const content = fs.readFileSync(best.full, 'utf8');
  const events = [];
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let o;
    try { o = JSON.parse(t); } catch { continue; }
    events.push(...parseTranscriptLine(o, newId));
  }
  const humanTurns = events.filter((e) => e.type === 'human_turn');
  console.log(`Parse: ${events.length} event, trong đó ${humanTurns.length} lượt người thật.`);

  const log = [];
  const rebuild = () => Projection.build(log);
  let proj = new Projection();
  const sorted = events.slice().sort((a, b) => (a.ts < b.ts ? -1 : 1));
  for (const ev of sorted) {
    if (ev.type === 'human_turn') {
      if (proj.hasProcessedTurn(ev.lineUuid)) continue;
      log.push(ev);
      proj = rebuild();
      const candidates = proj.openTasksForProject(ev.projectKey, 30);
      const g = await decideGrouping(ev.text, ev.ts, ev.sessionId, candidates, 20, ai);
      const taskId = g.decision === 'append' && g.taskId ? g.taskId : newId();
      log.push({ type: 'grouping_decision', eventId: newId(), ts: ev.ts, turnRef: ev.lineUuid, taskId, decision: g.decision, reason: g.reason, confidence: g.confidence });
      proj = rebuild();
      const task = proj.getTask(taskId);
      if (task && !task.epicId) {
        const epics = proj.getEpics().filter((e) => e.projectKey === task.projectKey).map((e) => ({ id: e.id, title: e.title }));
        const dec = await classifyTask({ taskText: `${task.title}. ${task.turns.map((t) => t.text).join(' ')}`, existingEpics: epics, ai, autoClassify: true, newEpicId: () => `epic-${newId()}` });
        if (dec) {
          log.push({ type: 'classification', eventId: newId(), ts: ev.ts, taskId, epicId: dec.epicId, epicTitle: dec.epicTitle, reason: dec.reason, confidence: dec.confidence });
          proj = rebuild();
        }
      }
    } else {
      log.push(ev);
    }
  }
  proj = rebuild();

  console.log(`\n=> ${proj.getTasks().length} task, ${proj.getEpics().length} epic\n`);
  for (const e of proj.getEpics()) {
    console.log(`EPIC: ${e.title}  (${e.taskIds.length} việc)`);
    for (const tid of e.taskIds) {
      const t = proj.getTask(tid);
      if (t) console.log(`   • ${t.title}  [${t.turns.length} lượt]`);
    }
  }
  const other = proj.getTasks().filter((t) => !t.epicId);
  if (other.length) {
    console.log(`\n(Chưa phân loại: ${other.length})`);
    for (const t of other.slice(0, 10)) console.log(`   • ${t.title}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
