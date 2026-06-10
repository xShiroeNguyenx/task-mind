import { Projection } from '../store/projection';
import { DailyReport, Task } from '../types';
import { dayGroupLabel, localDateKey, projectNameFromCwd } from '../util';

function taskActiveOn(task: Task, dateKey: string): boolean {
  if (localDateKey(task.createdAt) === dateKey || localDateKey(task.updatedAt) === dateKey) {
    return true;
  }
  return task.turns.some((t) => localDateKey(t.ts) === dateKey);
}

/** Dựng báo cáo cho một ngày (yyyy-mm-dd, giờ địa phương), gom theo Dự án (khớp cây checklist). */
export function buildDailyReport(proj: Projection, dateKey: string, now: Date = new Date()): DailyReport {
  const tasks = proj.getTasks().filter((t) => taskActiveOn(t, dateKey));

  const started: Task[] = [];
  const completed: Task[] = [];
  const inProgress: Task[] = [];
  for (const t of tasks) {
    if (t.status === 'done' && localDateKey(t.updatedAt) === dateKey) {
      completed.push(t);
    } else {
      inProgress.push(t);
    }
    if (localDateKey(t.createdAt) === dateKey) {
      started.push(t);
    }
  }

  // gom theo dự án (projectKey) — khớp với cây checklist
  const byProject = new Map<string, Task[]>();
  for (const t of tasks) {
    if (!byProject.has(t.projectKey)) {
      byProject.set(t.projectKey, []);
    }
    byProject.get(t.projectKey)!.push(t);
  }

  // dự án có việc cập nhật mới nhất lên đầu (giống thứ tự checklist)
  const latestOf = (list: Task[]) => list.reduce((m, t) => (t.updatedAt > m ? t.updatedAt : m), '');
  const perProject = Array.from(byProject.entries())
    .sort((a, b) => (latestOf(a[1]) < latestOf(b[1]) ? 1 : -1))
    .map(([projectKey, list]) => {
      const cwd = list[0]?.cwd ?? '';
      return {
        projectKey,
        projectName: projectNameFromCwd(cwd) || 'Khác',
        cwd,
        tasksCompleted: list.filter((t) => t.status === 'done' && localDateKey(t.updatedAt) === dateKey).map((t) => t.id),
        tasksInProgress: list.filter((t) => !(t.status === 'done' && localDateKey(t.updatedAt) === dateKey)).map((t) => t.id),
        tasksStarted: list.filter((t) => localDateKey(t.createdAt) === dateKey).map((t) => t.id),
      };
    });

  const sessions = new Set<string>();
  let turns = 0;
  for (const t of tasks) {
    t.sessionIds.forEach((s) => sessions.add(s));
    turns += t.turns.filter((x) => localDateKey(x.ts) === dateKey).length;
  }

  const narrative = summaryLine(dateKey, completed.length, inProgress.length, perProject.length, now);

  return {
    date: dateKey,
    generatedAt: now.toISOString(),
    perProject,
    totals: {
      started: started.length,
      completed: completed.length,
      inProgress: inProgress.length,
      turns,
      sessions: sessions.size,
    },
    narrative,
  };
}

/** Câu tóm tắt số liệu (dùng chung cho narrative webview + đầu file Markdown). */
export function summaryLine(
  dateKey: string,
  completedCount: number,
  inProgressCount: number,
  projectCount: number,
  now: Date = new Date(),
): string {
  const label = dayGroupLabel(dateKey, now).toLowerCase();
  return `Báo cáo ${label} (${dateKey}): hoàn thành ${completedCount} việc, đang làm ${inProgressCount} việc thuộc ${projectCount} dự án.`;
}

/** Kết quả sau khi lọc bỏ các task bị loại — dùng chung cho KPI/highlight (webview) và Markdown. */
export interface EffectiveReport {
  completedIds: string[];
  inProgressIds: string[];
  startedIds: string[];
  projectCount: number;
  totals: DailyReport['totals'];
}

/**
 * Tính lại totals + danh sách id sau khi bỏ các task trong `excluded` và các dự án trong `excludedProjects`.
 * Bất biến: `computeEffective(proj, report, new Set(), new Set())` phải khớp đúng `report.totals`.
 */
export function computeEffective(
  proj: Projection,
  report: DailyReport,
  excluded: Set<string> = new Set(),
  excludedProjects: Set<string> = new Set(),
): EffectiveReport {
  const groups = report.perProject.filter((g) => !excludedProjects.has(g.projectKey));
  const keep = (ids: string[]) => ids.filter((id) => !excluded.has(id));
  const completedIds = groups.flatMap((g) => keep(g.tasksCompleted));
  const inProgressIds = groups.flatMap((g) => keep(g.tasksInProgress));
  const startedIds = groups.flatMap((g) => keep(g.tasksStarted));
  const projectCount = groups.filter((g) =>
    [...g.tasksCompleted, ...g.tasksInProgress].some((id) => !excluded.has(id)),
  ).length;

  const sessions = new Set<string>();
  let turns = 0;
  const seen = new Set<string>();
  for (const id of [...completedIds, ...inProgressIds]) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const t = proj.getTask(id);
    if (!t) {
      continue;
    }
    t.sessionIds.forEach((s) => sessions.add(s));
    turns += t.turns.filter((x) => localDateKey(x.ts) === report.date).length;
  }

  return {
    completedIds,
    inProgressIds,
    startedIds,
    projectCount,
    totals: {
      started: startedIds.length,
      completed: completedIds.length,
      inProgress: inProgressIds.length,
      turns,
      sessions: sessions.size,
    },
  };
}

/** Tuỳ chọn kết xuất (Markdown/TSV): bỏ task/dự án bị loại, ẩn/hiện sub-task. */
export interface MarkdownOptions {
  excludedTaskIds?: Set<string>;
  excludedProjectKeys?: Set<string>;
  showSubtasks?: boolean;
}

/** Kết xuất báo cáo ra Markdown (tôn trọng task/dự án bị loại + tuỳ chọn sub-task). */
export function reportToMarkdown(proj: Projection, report: DailyReport, opts: MarkdownOptions = {}): string {
  const excluded = opts.excludedTaskIds ?? new Set<string>();
  const excludedProjects = opts.excludedProjectKeys ?? new Set<string>();
  const showSubtasks = opts.showSubtasks ?? true;
  const eff = computeEffective(proj, report, excluded, excludedProjects);

  const lines: string[] = [];
  lines.push(`# Báo cáo công việc — ${report.date}`);
  lines.push('');
  lines.push(summaryLine(report.date, eff.totals.completed, eff.totals.inProgress, eff.projectCount));
  lines.push('');
  lines.push(`> Tổng: ${eff.totals.started} bắt đầu · ${eff.totals.completed} xong · ${eff.totals.inProgress} đang làm · ${eff.totals.turns} lượt · ${eff.totals.sessions} phiên`);
  lines.push('');

  for (const grp of report.perProject) {
    if (excludedProjects.has(grp.projectKey)) {
      continue; // dự án bị bỏ tick → loại hẳn khỏi Markdown
    }
    const render = (id: string) => {
      if (excluded.has(id)) {
        return '';
      }
      const t = proj.getTask(id);
      if (!t) {
        return '';
      }
      const head = `- [${t.status === 'done' ? 'x' : ' '}] ${t.title}`;
      if (!showSubtasks) {
        return head;
      }
      const subs = t.subtaskIds
        .map((sid) => proj.getSubtask(sid))
        .filter(Boolean)
        .map((s) => `  - [${s!.status === 'done' ? 'x' : ' '}] ${s!.title}`);
      return [head, ...subs].join('\n');
    };
    const completed = grp.tasksCompleted.map(render).filter(Boolean);
    const inProgress = grp.tasksInProgress.map(render).filter(Boolean);
    if (!completed.length && !inProgress.length) {
      continue; // dự án không còn task nào sau khi loại → bỏ qua tiêu đề
    }
    lines.push(`## ${grp.projectName}`);
    if (completed.length) {
      lines.push('**Đã xong:**');
      lines.push(...completed);
    }
    if (inProgress.length) {
      lines.push('**Đang làm:**');
      lines.push(...inProgress);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Kết xuất báo cáo ra TSV (tab-separated, dán/import thẳng vào Google Sheets).
 * Mỗi task một dòng; bật sub-task thì mỗi sub-task thêm một dòng (lặp lại cột Task).
 * Tôn trọng cùng bộ lọc với Markdown. Có BOM UTF-8 để Excel mở không vỡ tiếng Việt.
 */
export function reportToTsv(proj: Projection, report: DailyReport, opts: MarkdownOptions = {}): string {
  const excluded = opts.excludedTaskIds ?? new Set<string>();
  const excludedProjects = opts.excludedProjectKeys ?? new Set<string>();
  const showSubtasks = opts.showSubtasks ?? true;

  // Tab/xuống dòng trong tiêu đề sẽ phá cột → ép về khoảng trắng.
  const cell = (s: string) => s.replace(/[\t\r\n]+/g, ' ').trim();

  const rows: string[] = ['Ngày\tDự án\tTask\tSub-task\tTrạng thái'];
  for (const grp of report.perProject) {
    if (excludedProjects.has(grp.projectKey)) {
      continue;
    }
    const pushTask = (id: string, status: string) => {
      if (excluded.has(id)) {
        return;
      }
      const t = proj.getTask(id);
      if (!t) {
        return;
      }
      rows.push([report.date, cell(grp.projectName), cell(t.title), '', status].join('\t'));
      if (!showSubtasks) {
        return;
      }
      for (const sid of t.subtaskIds) {
        const s = proj.getSubtask(sid);
        if (s) {
          rows.push([report.date, cell(grp.projectName), cell(t.title), cell(s.title), s.status === 'done' ? 'Đã xong' : 'Đang làm'].join('\t'));
        }
      }
    };
    grp.tasksCompleted.forEach((id) => pushTask(id, 'Đã xong'));
    grp.tasksInProgress.forEach((id) => pushTask(id, 'Đang làm'));
  }

  return '\ufeff' + rows.join('\n') + '\n';
}
