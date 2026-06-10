import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { CaptureService } from '../capture/capture-service';
import { DailyReport } from '../types';
import { dayGroupLabel, todayKey } from '../util';
import { buildDailyReport, computeEffective, reportToMarkdown, reportToTsv, summaryLine } from './report-builder';

function addDays(dateKey: string, delta: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export class ReportView {
  private panel: vscode.WebviewPanel | undefined;
  private dateKey = todayKey();
  /** Task bị bỏ tick → loại khỏi tổng/highlight/Markdown. Là bộ lọc xem tạm thời, KHÔNG ghi vào event log. */
  private excludedTaskIds = new Set<string>();
  /** Dự án bị bỏ tick → loại toàn bộ task của dự án khỏi tổng/highlight/Markdown. */
  private excludedProjectKeys = new Set<string>();
  /** Bật/tắt hiển thị sub-task trong báo cáo. */
  private showSubtasks = true;

  constructor(private readonly service: CaptureService) {}

  show(dateKey?: string): void {
    if (dateKey) {
      this.dateKey = dateKey;
    }
    // Mở mới = trạng thái lọc sạch (tránh task/dự án bị ẩn vô hình từ lần trước).
    this.excludedTaskIds.clear();
    this.excludedProjectKeys.clear();
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'taskMind.report',
        'Báo cáo Task Mind',
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      this.panel.onDidDispose(() => (this.panel = undefined));
      this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    }
    this.panel.reveal();
    this.render();
  }

  private async onMessage(msg: any): Promise<void> {
    if (!msg) {
      return;
    }
    if (msg.type === 'prevDay') {
      this.dateKey = addDays(this.dateKey, -1);
      this.excludedTaskIds.clear(); // đổi ngày = reset lựa chọn loại task/dự án
      this.excludedProjectKeys.clear();
      this.render();
    } else if (msg.type === 'nextDay') {
      this.dateKey = addDays(this.dateKey, 1);
      this.excludedTaskIds.clear();
      this.excludedProjectKeys.clear();
      this.render();
    } else if (msg.type === 'toggleTask') {
      if (msg.included) {
        this.excludedTaskIds.delete(String(msg.id));
      } else {
        this.excludedTaskIds.add(String(msg.id));
      }
      this.render();
    } else if (msg.type === 'toggleProject') {
      if (msg.included) {
        this.excludedProjectKeys.delete(String(msg.key));
      } else {
        this.excludedProjectKeys.add(String(msg.key));
      }
      this.render();
    } else if (msg.type === 'toggleSubtasks') {
      this.showSubtasks = !!msg.value;
      this.render();
    } else if (msg.type === 'resetSelection') {
      this.excludedTaskIds.clear();
      this.excludedProjectKeys.clear();
      this.render();
    } else if (msg.type === 'export') {
      await this.export();
    } else if (msg.type === 'exportTsv') {
      await this.export('tsv');
    }
  }

  private currentReport(): DailyReport {
    return buildDailyReport(this.service.getProjection(), this.dateKey);
  }

  async export(format: 'md' | 'tsv' = 'md'): Promise<void> {
    const report = this.currentReport();
    const opts = {
      excludedTaskIds: this.excludedTaskIds,
      excludedProjectKeys: this.excludedProjectKeys,
      showSubtasks: this.showSubtasks,
    };
    const content =
      format === 'tsv'
        ? reportToTsv(this.service.getProjection(), report, opts)
        : reportToMarkdown(this.service.getProjection(), report, opts);
    const uri = await vscode.window.showSaveDialog({
      filters: format === 'tsv' ? { 'TSV (Google Sheets)': ['tsv'] } : { Markdown: ['md'] },
      defaultUri: vscode.Uri.file(`task-mind-report-${report.date}.${format}`),
    });
    if (uri) {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
      vscode.window.showInformationMessage(`Đã xuất báo cáo: ${uri.fsPath}`);
    }
  }

  private render(): void {
    if (!this.panel) {
      return;
    }
    const report = this.currentReport();
    this.panel.title = `Báo cáo — ${report.date}`;
    this.panel.webview.html = this.html(report);
  }

  private html(report: DailyReport): string {
    const proj = this.service.getProjection();
    const nonce = randomUUID().replace(/-/g, '');
    const cspSource = this.panel!.webview.cspSource;

    // Lọc theo lựa chọn người dùng: bỏ task/dự án được loại, ẩn/hiện sub-task. Tính chung cho KPI/highlight/narrative.
    const eff = computeEffective(proj, report, this.excludedTaskIds, this.excludedProjectKeys);
    const narrative = summaryLine(report.date, eff.totals.completed, eff.totals.inProgress, eff.projectCount);

    // Danh sách chi tiết theo dự án — luôn hiện MỌI dự án/task (kể cả bị loại, làm mờ) kèm checkbox để bật/tắt.
    const projectsHtml = report.perProject
      .map((grp) => {
        const projExcluded = this.excludedProjectKeys.has(grp.projectKey);
        const renderTask = (id: string) => {
          const t = proj.getTask(id);
          if (!t) {
            return '';
          }
          const excluded = this.excludedTaskIds.has(t.id);
          const cls = `${t.status === 'done' ? 'done' : ''} ${excluded ? 'excluded' : ''}`.trim();
          const subs = this.showSubtasks
            ? t.subtaskIds
                .map((sid) => proj.getSubtask(sid))
                .filter(Boolean)
                .map((s) => `<li class="${s!.status === 'done' ? 'done' : ''}">${escapeHtml(s!.title)}</li>`)
                .join('')
            : '';
          return `<li class="task ${cls}">
            <label class="task-row"><input type="checkbox" class="incl" data-id="${escapeHtml(t.id)}" ${excluded ? '' : 'checked'}${projExcluded ? ' disabled' : ''}><span>${escapeHtml(t.title)}</span></label>
            ${subs ? `<ul>${subs}</ul>` : ''}
          </li>`;
        };
        const completed = grp.tasksCompleted.map(renderTask).join('');
        const inProgress = grp.tasksInProgress.map(renderTask).join('');
        return `<section class="proj${projExcluded ? ' excluded' : ''}">
          <h2><label class="proj-row" title="Bỏ tick để loại cả dự án khỏi báo cáo"><input type="checkbox" class="incl-proj" data-key="${escapeHtml(grp.projectKey)}" ${projExcluded ? '' : 'checked'}><span>${escapeHtml(grp.projectName)}</span></label></h2>
          ${completed ? `<h4>Đã xong</h4><ul>${completed}</ul>` : ''}
          ${inProgress ? `<h4>Đang làm</h4><ul>${inProgress}</ul>` : ''}
        </section>`;
      })
      .join('');

    const empty = report.perProject.length === 0 ? '<p class="muted">Không có việc nào trong ngày này.</p>' : '';

    // Tóm tắt nhanh: chỉ gồm task ĐƯỢC CHỌN (không bị loại), tách 2 danh sách bullet.
    const liOf = (id: string) => {
      const t = proj.getTask(id);
      return t ? `<li>${escapeHtml(t.title)}</li>` : '';
    };
    const completedLis = eff.completedIds.map(liOf).filter(Boolean);
    const inProgressLis = eff.inProgressIds.map(liOf).filter(Boolean);
    const highlightsHtml = `
      ${completedLis.length ? `<h4 class="hl-head hl-done">✓ Đã xong (${completedLis.length})</h4><ul class="hl">${completedLis.join('')}</ul>` : ''}
      ${inProgressLis.length ? `<h4 class="hl-head hl-doing">◷ Đang làm (${inProgressLis.length})</h4><ul class="hl">${inProgressLis.join('')}</ul>` : ''}
    `;

    return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 16px 24px; }
  header { display: flex; align-items: center; gap: 12px; position: sticky; top: 0; background: var(--vscode-editor-background); padding: 12px 0; border-bottom: 1px solid var(--vscode-panel-border); }
  header h1 { font-size: 1.1rem; margin: 0; flex: 1; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 10px; border-radius: 4px; cursor: pointer; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button[hidden] { display: none; }
  .ctrls { display: flex; align-items: center; gap: 10px; }
  .ctrl { display: inline-flex; align-items: center; gap: 4px; font-size: .85rem; color: var(--vscode-descriptionForeground); cursor: pointer; user-select: none; white-space: nowrap; }
  .ctrl input { margin: 0; }
  .kpis { display: flex; gap: 16px; margin: 16px 0; }
  .kpi { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px 14px; min-width: 70px; text-align: center; }
  .kpi b { display: block; font-size: 1.4rem; }
  .narrative { font-style: italic; color: var(--vscode-descriptionForeground); margin: 8px 0 4px; }
  .highlights { margin: 4px 0 8px; }
  .hl-head { margin: 14px 0 4px; font-weight: 600; font-size: .95rem; }
  .hl-head.hl-done { color: var(--vscode-charts-green, var(--vscode-foreground)); }
  .hl-head.hl-doing { color: var(--vscode-charts-yellow, var(--vscode-foreground)); }
  ul.hl { margin: 2px 0 6px; padding-left: 20px; }
  ul.hl li { margin: 3px 0; line-height: 1.4; }
  .proj { margin: 16px 0; }
  .proj h2 { font-size: 1rem; border-left: 3px solid var(--vscode-textLink-foreground); padding-left: 8px; }
  .proj-row { cursor: pointer; }
  .proj-row input.incl-proj { margin: 0 6px 0 0; cursor: pointer; vertical-align: middle; }
  .proj.excluded { opacity: .4; }
  .proj.excluded h2 > .proj-row span { text-decoration: line-through; }
  h4 { margin: 8px 0 2px; color: var(--vscode-descriptionForeground); }
  ul { margin: 2px 0 8px; }
  li.task { margin: 2px 0; }
  .task-row { cursor: pointer; }
  .task-row input.incl { margin: 0 6px 0 0; cursor: pointer; vertical-align: middle; }
  li.done > .task-row span, li.done > span, li.done { text-decoration: line-through; opacity: .7; }
  li.task.excluded { opacity: .4; }
  li.task.excluded > .task-row span { text-decoration: line-through; }
  .muted { color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
  <header>
    <button class="secondary" id="prev">◀ Hôm trước</button>
    <h1>${escapeHtml(dayGroupLabel(report.date))} — ${report.date}</h1>
    <div class="ctrls">
      <label class="ctrl" title="Ẩn/hiện sub-task trong báo cáo và khi xuất Markdown"><input type="checkbox" id="toggleSub" ${this.showSubtasks ? 'checked' : ''}> Sub-task</label>
      <button class="secondary" id="reset"${this.excludedTaskIds.size + this.excludedProjectKeys.size ? '' : ' hidden'}>↺ Hiện lại (${this.excludedTaskIds.size + this.excludedProjectKeys.size})</button>
    </div>
    <button class="secondary" id="next">Hôm sau ▶</button>
    <button class="secondary" id="exportTsv" title="Xuất TSV (tab-separated) để import/dán vào Google Sheets">Xuất TSV</button>
    <button id="export">Xuất Markdown</button>
  </header>
  <p class="narrative">${escapeHtml(narrative)}</p>
  <div class="kpis">
    <div class="kpi"><b>${eff.totals.started}</b>bắt đầu</div>
    <div class="kpi"><b>${eff.totals.completed}</b>xong</div>
    <div class="kpi"><b>${eff.totals.inProgress}</b>đang làm</div>
    <div class="kpi"><b>${eff.totals.turns}</b>lượt</div>
  </div>
  ${empty}
  <div class="highlights">${highlightsHtml}</div>
  ${projectsHtml}
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('prev').addEventListener('click', () => vscode.postMessage({ type: 'prevDay' }));
    document.getElementById('next').addEventListener('click', () => vscode.postMessage({ type: 'nextDay' }));
    document.getElementById('export').addEventListener('click', () => vscode.postMessage({ type: 'export' }));
    document.getElementById('exportTsv').addEventListener('click', () => vscode.postMessage({ type: 'exportTsv' }));
    document.getElementById('toggleSub').addEventListener('change', (e) => vscode.postMessage({ type: 'toggleSubtasks', value: e.target.checked }));
    const resetBtn = document.getElementById('reset');
    if (resetBtn) { resetBtn.addEventListener('click', () => vscode.postMessage({ type: 'resetSelection' })); }
    document.querySelectorAll('input.incl').forEach((cb) => cb.addEventListener('change', () => vscode.postMessage({ type: 'toggleTask', id: cb.dataset.id, included: cb.checked })));
    document.querySelectorAll('input.incl-proj').forEach((cb) => cb.addEventListener('change', () => vscode.postMessage({ type: 'toggleProject', key: cb.dataset.key, included: cb.checked })));
  </script>
</body>
</html>`;
  }

  dispose(): void {
    this.panel?.dispose();
  }
}
